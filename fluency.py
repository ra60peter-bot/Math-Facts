"""Evidence-based fluency scheduling for math fact practice.

Designed for IRREGULAR usage: 3-5 sessions per week, not daily.

Key design decisions for intermittent learners:
  1. Spacing steps use wider intervals — "next session" might be 2+ days away
  2. Overdue grace period — a 2-day gap between sessions is normal, not a failure
  3. MASTERED cards don't demote on slow answers — first answers after a break
     are naturally slower; only actual errors demote
  4. FSRS due dates and retrievability drive cross-session priority; fluency
     weakness (difficulty + speed) breaks ties
  5. Streaks persist across sessions — a kid who got 3×7 right on Monday keeps
     that streak on Wednesday unless they get it wrong

Evidence basis:
  - Response latency as fluency signal (Poncy et al., 2010)
  - Expanding retrieval practice (Karpicke & Roediger, 2007)
  - Interleaving benefits for math (Rohrer et al., 2015)
  - Spaced practice with variable intervals (Cepeda et al., 2006)
  - Overlearning diminishing returns (Roediger & Karpicke, 2006)
  - Desirable difficulties framework (Bjork & Bjork, 2011)
"""

from datetime import datetime, timedelta, timezone
from enum import IntEnum

from fsrs import Card as FSRSCard
from fsrs import Rating as FSRSRating
from fsrs import Scheduler as FSRSScheduler


FSRS_SCHEDULER = FSRSScheduler(desired_retention=0.9, enable_fuzzing=True)


# ═══════════════════════════════════════════════════════════════════════
#  Grades
# ═══════════════════════════════════════════════════════════════════════

class Grade(IntEnum):
    AGAIN = 0   # Wrong, timeout, or nonsense
    HARD  = 1   # Correct but slow (>1.5s — counting, not recalling)
    GOOD  = 2   # Correct within target (functional recall)
    EASY  = 3   # Correct and very fast (<0.8s — truly automatic)


# ═══════════════════════════════════════════════════════════════════════
#  Card States
# ═══════════════════════════════════════════════════════════════════════

LEARNING  = "learning"    # New or recently failed — drill every session
REVIEWING = "reviewing"   # Known but building fluency — expanding spacing
MASTERED  = "mastered"    # Automatic recall — occasional retention checks


# ═══════════════════════════════════════════════════════════════════════
#  Configuration
# ═══════════════════════════════════════════════════════════════════════

class FluencyConfig:
    """Tunable parameters. Defaults assume 3-5 sessions per week."""

    # ── Response time thresholds (ms) ───────────────────────────────────
    FAST_MS    = 950     # Below = automatic / EASY
    TARGET_MS  = 1500    # Below = acceptable / GOOD; above = HARD
    TIMEOUT_MS = 6000    # Above = treated as AGAIN

    # ── Graduation thresholds ───────────────────────────────────────────
    LEARNING_GRAD_STREAK = 3    # Consecutive correct (any speed) to exit LEARNING
    MASTERY_FAST_STREAK  = 5    # Consecutive fast+correct to reach MASTERED

    # ── Within-session retry gaps ───────────────────────────────────────
    AGAIN_BASE_GAP       = 3
    HARD_BASE_GAP        = 6
    MAX_GAP              = 12
    MAX_SESSION_RETRIES  = 6

    # ── Across-session intervals (days) ─────────────────────────────────
    # Wider steps than Anki — a kid using this 3-5x/week won't see
    # a card due tomorrow if they don't open the app. These steps
    # roughly map to: next session, next week, two weeks, month, 2 months.
    LEARNING_INTERVAL    = 0.0
    REVIEWING_STEPS      = [2, 5, 12, 25, 50]
    MASTERED_INTERVAL    = 45

    # ── Overdue grace period (days) ─────────────────────────────────────
    # Days past due before we start boosting priority.
    # 2 days = normal gap between sessions for 3-5x/week usage.
    # A card due today that's seen in 2 days is NOT overdue.
    OVERDUE_GRACE_DAYS   = 2

    # ── Priority scoring ────────────────────────────────────────────────
    LEARNING_BASE_PRIORITY  = 100
    REVIEWING_BASE_PRIORITY = 50
    MASTERED_BASE_PRIORITY  = 5

    # ── Difficulty / EMA ────────────────────────────────────────────────
    DIFFICULTY_STEP = 0.1
    EMA_ALPHA       = 0.3   # Weight for newest response time in rolling avg


# ═══════════════════════════════════════════════════════════════════════
#  Default card state
# ═══════════════════════════════════════════════════════════════════════

def default_card_state():
    return {
        "state":                LEARNING,
        "total_attempts":       0,
        "total_correct":        0,
        "consecutive_correct":  0,
        "consecutive_fast":     0,
        "consecutive_failures": 0,
        "rolling_avg_ms":       0.0,
        "last_response_ms":     0,
        "difficulty":           0.3,
        "interval_days":        0.0,
        "due_timestamp":        None,
        "last_seen_at":         None,
        "fsrs_card_json":       None,
    }


def state_from_db_row(row) -> dict:
    keys = [
        "state", "total_attempts", "total_correct",
        "consecutive_correct", "consecutive_fast", "consecutive_failures",
        "rolling_avg_ms", "last_response_ms", "difficulty",
        "interval_days", "due_timestamp", "last_seen_at", "fsrs_card_json",
    ]
    d = default_card_state()
    for k in keys:
        try:
            val = row[k]
            if val is not None:
                d[k] = val
        except (KeyError, IndexError):
            pass
    return d


# ═══════════════════════════════════════════════════════════════════════
#  Grading
# ═══════════════════════════════════════════════════════════════════════

def grade_response(is_correct: bool, response_ms: int,
                   cfg: FluencyConfig = None) -> Grade:
    if cfg is None:
        cfg = FluencyConfig()
    if not is_correct or response_ms >= cfg.TIMEOUT_MS:
        return Grade.AGAIN
    if response_ms > cfg.TARGET_MS:
        return Grade.HARD
    if response_ms <= cfg.FAST_MS:
        return Grade.EASY
    return Grade.GOOD


# ═══════════════════════════════════════════════════════════════════════
#  State Update
# ═══════════════════════════════════════════════════════════════════════

def update_card_state(state: dict, grade: Grade, response_ms: int,
                      cfg: FluencyConfig = None, now: datetime = None) -> dict:
    """Update card state after a review.

    State machine for irregular users:
      LEARNING  → REVIEWING  (3 consecutive correct at any speed)
      REVIEWING → MASTERED   (5 consecutive fast+correct)
      REVIEWING → LEARNING   (AGAIN only — wrong answers)
      MASTERED  → LEARNING   (AGAIN only — wrong answers)
      MASTERED  stays on HARD (slow after a break is normal, not a failure)

    Streaks persist across sessions. A kid who got 7×8 right Monday
    keeps that streak Wednesday. Only an actual error resets it.
    """
    if cfg is None:
        cfg = FluencyConfig()

    s = dict(state)
    now = now or datetime.now()

    # ── Bookkeeping ─────────────────────────────────────────────────────
    s["total_attempts"] = s.get("total_attempts", 0) + 1
    s["last_response_ms"] = response_ms
    s["last_seen_at"] = now.isoformat()
    s["fsrs_card_json"] = update_fsrs_card(
        state.get("fsrs_card_json"), grade, response_ms, now
    )

    # Rolling average response time (EMA)
    old_avg = s.get("rolling_avg_ms") or 0.0
    if old_avg == 0:
        s["rolling_avg_ms"] = float(response_ms)
    else:
        a = cfg.EMA_ALPHA
        s["rolling_avg_ms"] = a * response_ms + (1 - a) * old_avg

    # ── Streak tracking ─────────────────────────────────────────────────
    if grade == Grade.AGAIN:
        s["consecutive_correct"] = 0
        s["consecutive_fast"] = 0
        s["consecutive_failures"] = s.get("consecutive_failures", 0) + 1
        s["difficulty"] = min(1.0, s.get("difficulty", 0.3) + cfg.DIFFICULTY_STEP * 2)
    else:
        s["total_correct"] = s.get("total_correct", 0) + 1
        s["consecutive_correct"] = s.get("consecutive_correct", 0) + 1
        s["consecutive_failures"] = 0

        step = cfg.DIFFICULTY_STEP * (2 if grade == Grade.EASY else 1)
        s["difficulty"] = max(0.0, s.get("difficulty", 0.3) - step)

        if grade == Grade.EASY:
            s["consecutive_fast"] = s.get("consecutive_fast", 0) + 1
        elif grade == Grade.HARD:
            s["consecutive_fast"] = 0
        # GOOD: preserve consecutive_fast (partial credit)

    # ── State transitions ───────────────────────────────────────────────
    cur = s.get("state", LEARNING)

    if grade == Grade.AGAIN:
        # ── WRONG → drop to LEARNING, due immediately ──────────────────
        # This is the ONLY way to demote. Being slow after a break does
        # NOT demote — that would punish the kid for not using the app.
        s["state"] = LEARNING
        s["interval_days"] = cfg.LEARNING_INTERVAL
        s["due_timestamp"] = now.isoformat()

    elif cur == LEARNING:
        if s["consecutive_correct"] >= cfg.LEARNING_GRAD_STREAK:
            s["state"] = REVIEWING
            s["interval_days"] = cfg.REVIEWING_STEPS[0]
            s["due_timestamp"] = (
                now + timedelta(days=cfg.REVIEWING_STEPS[0])
            ).isoformat()
        else:
            # Still learning — due next session
            s["interval_days"] = cfg.LEARNING_INTERVAL
            s["due_timestamp"] = now.isoformat()

    elif cur == REVIEWING:
        if s.get("consecutive_fast", 0) >= cfg.MASTERY_FAST_STREAK:
            s["state"] = MASTERED
            s["interval_days"] = cfg.MASTERED_INTERVAL
            s["due_timestamp"] = (
                now + timedelta(days=cfg.MASTERED_INTERVAL)
            ).isoformat()
        else:
            cur_iv = s.get("interval_days") or 2
            steps = cfg.REVIEWING_STEPS

            if grade == Grade.HARD:
                # Slow but correct — don't advance, slight shrink
                s["interval_days"] = max(2, cur_iv * 0.7)
            else:
                # GOOD or EASY — advance to next step
                new_iv = steps[-1]
                for step in steps:
                    if step > cur_iv:
                        new_iv = step
                        break
                if grade == Grade.EASY and new_iv < steps[-1]:
                    for step in steps:
                        if step > new_iv:
                            new_iv = step
                            break
                s["interval_days"] = new_iv

            s["due_timestamp"] = (
                now + timedelta(days=s["interval_days"])
            ).isoformat()

    elif cur == MASTERED:
        if grade == Grade.HARD:
            # Slow on a mastered card after a break is NORMAL.
            # Don't demote — just schedule a sooner retention check.
            s["interval_days"] = max(7, cfg.MASTERED_INTERVAL * 0.5)
            s["due_timestamp"] = (
                now + timedelta(days=s["interval_days"])
            ).isoformat()
        else:
            # Still mastered — full retention interval
            s["interval_days"] = cfg.MASTERED_INTERVAL
            s["due_timestamp"] = (
                now + timedelta(days=cfg.MASTERED_INTERVAL)
            ).isoformat()

    return s


# ═══════════════════════════════════════════════════════════════════════
#  Priority Scoring
# ═══════════════════════════════════════════════════════════════════════

def compute_priority(state: dict, cfg: FluencyConfig = None) -> float:
    """Compute priority score for a card. Higher = show sooner.

    For irregular users, priority is driven more by WEAKNESS (difficulty,
    speed, recent failures) than by OVERDUE TIME. A kid who skips 2 days
    shouldn't see their priority scores explode.

    Factors:
      1. State (LEARNING >> REVIEWING >> MASTERED)
      2. Overdue ratio with grace period (gentle boost, not panic)
      3. Difficulty (harder cards get a boost)
      4. Speed (slower rolling avg → higher priority)
      5. Recent failures (recently wrong = urgent)
    """
    if cfg is None:
        cfg = FluencyConfig()

    st = state.get("state", LEARNING)

    # Base weight by state
    if st == LEARNING:
        base = cfg.LEARNING_BASE_PRIORITY
    elif st == REVIEWING:
        base = cfg.REVIEWING_BASE_PRIORITY
    else:
        base = cfg.MASTERED_BASE_PRIORITY

    # ── Overdue factor with grace period ────────────────────────────────
    # Grace period: first OVERDUE_GRACE_DAYS past due = no boost.
    # After that, gentle logarithmic boost (not linear explosion).
    due = state.get("due_timestamp")
    if due:
        try:
            due_dt = datetime.fromisoformat(due)
            overdue_days = (datetime.now() - due_dt).total_seconds() / 86400

            if overdue_days <= 0:
                overdue_f = 0.1  # Not yet due
            elif overdue_days <= cfg.OVERDUE_GRACE_DAYS:
                overdue_f = 1.0  # Within grace period — neutral
            else:
                # Gentle boost: days past grace / interval, capped at 3x
                effective_overdue = overdue_days - cfg.OVERDUE_GRACE_DAYS
                interval = max(s if (s := state.get("interval_days")) else 2, 2)
                ratio = effective_overdue / interval
                overdue_f = 1.0 + min(ratio, 3.0)
        except (ValueError, TypeError):
            overdue_f = 1.0
    else:
        overdue_f = 1.0  # Never seen — neutral

    # ── Difficulty boost (range 1.0–2.0) ────────────────────────────────
    diff_f = 1.0 + (state.get("difficulty") or 0.3)

    # ── Speed factor: slower avg → higher priority ──────────────────────
    avg_ms = state.get("rolling_avg_ms") or 0
    if avg_ms > cfg.TARGET_MS:
        speed_f = 1.5
    elif avg_ms > cfg.FAST_MS:
        speed_f = 1.2
    else:
        speed_f = 1.0

    # ── Failure recency boost ───────────────────────────────────────────
    fails = state.get("consecutive_failures") or 0
    fail_f = 1.0 + min(fails * 0.5, 2.0)

    fluency_tie_breaker = base * overdue_f * diff_f * speed_f * fail_f
    return compute_fsrs_priority(state) + min(fluency_tie_breaker, 9999)


def update_fsrs_card(card_json, grade: Grade, response_ms: int,
                     review_datetime: datetime = None) -> str:
    """Review a card with FSRS at 90% desired retention and serialize it."""
    try:
        card = FSRSCard.from_json(card_json) if card_json else FSRSCard()
    except (TypeError, ValueError):
        card = FSRSCard()

    reviewed_at = review_datetime or datetime.now(timezone.utc)
    if reviewed_at.tzinfo is None:
        reviewed_at = reviewed_at.astimezone(timezone.utc)
    else:
        reviewed_at = reviewed_at.astimezone(timezone.utc)
    rating = {
        Grade.AGAIN: FSRSRating.Again,
        Grade.HARD: FSRSRating.Hard,
        Grade.GOOD: FSRSRating.Good,
        Grade.EASY: FSRSRating.Easy,
    }[grade]
    reviewed, _ = FSRS_SCHEDULER.review_card(
        card, rating, review_datetime=reviewed_at, review_duration=response_ms
    )
    return reviewed.to_json()


def compute_fsrs_priority(state: dict, now: datetime = None) -> float:
    """Rank due FSRS cards first, then new cards, then future reviews."""
    card_json = state.get("fsrs_card_json")
    if not card_json:
        return 500_000.0
    try:
        card = FSRSCard.from_json(card_json)
    except (TypeError, ValueError):
        return 500_000.0

    current = now or datetime.now(timezone.utc)
    if current.tzinfo is None:
        current = current.astimezone(timezone.utc)
    else:
        current = current.astimezone(timezone.utc)
    due = card.due.astimezone(timezone.utc)
    if due <= current:
        retrievability = FSRS_SCHEDULER.get_card_retrievability(card, current)
        overdue_days = max(0.0, (current - due).total_seconds() / 86400)
        return 1_000_000.0 + (1.0 - retrievability) * 100_000.0 + min(overdue_days, 365)

    days_until_due = max((due - current).total_seconds() / 86400, 0.0)
    return 100_000.0 / (1.0 + days_until_due)


# ═══════════════════════════════════════════════════════════════════════
#  Within-Session Retry Gap
# ═══════════════════════════════════════════════════════════════════════

def compute_retry_gap(grade: Grade, retry_count: int,
                      cfg: FluencyConfig = None) -> int:
    """How many other cards to show before retrying this card.

    Returns 0 if no retry needed (GOOD/EASY, or max retries hit).
    """
    if cfg is None:
        cfg = FluencyConfig()

    if retry_count >= cfg.MAX_SESSION_RETRIES:
        return 0  # Frustration guard

    if grade == Grade.AGAIN:
        return min(cfg.AGAIN_BASE_GAP + retry_count, cfg.MAX_GAP)
    elif grade == Grade.HARD:
        return min(cfg.HARD_BASE_GAP + retry_count, cfg.MAX_GAP)
    else:
        return 0
