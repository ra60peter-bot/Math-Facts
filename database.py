"""SQLite database layer for the Math Flashcard app."""

import sqlite3
import threading
from datetime import datetime

from app_paths import seed_user_file


class Database:
    def __init__(self, db_path=None):
        if db_path is None:
            db_path = seed_user_file("flashcards.db")
        self.conn = sqlite3.connect(str(db_path), check_same_thread=False)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA journal_mode=WAL")
        self._lock = threading.Lock()  # Thread-safe access
        self._create_tables()
        self._seed_data()

    # ── Schema ──────────────────────────────────────────────────────────

    def _create_tables(self):
        self.conn.executescript("""
            CREATE TABLE IF NOT EXISTS users (
                id   INTEGER PRIMARY KEY,
                name TEXT UNIQUE NOT NULL
            );

            CREATE TABLE IF NOT EXISTS cards (
                id  INTEGER PRIMARY KEY,
                op  TEXT    NOT NULL DEFAULT 'add',
                a   INTEGER NOT NULL,
                b   INTEGER NOT NULL,
                UNIQUE(op, a, b)
            );

            CREATE TABLE IF NOT EXISTS user_card_state (
                user_id              INTEGER NOT NULL,
                card_id              INTEGER NOT NULL,
                ease_factor          REAL    DEFAULT 2.5,
                interval_days        REAL    DEFAULT 0,
                repetitions          INTEGER DEFAULT 0,
                due_timestamp        TEXT,
                total_attempts       INTEGER DEFAULT 0,
                total_correct        INTEGER DEFAULT 0,
                total_time_ms        INTEGER DEFAULT 0,
                state                TEXT    DEFAULT 'learning',
                consecutive_correct  INTEGER DEFAULT 0,
                consecutive_fast     INTEGER DEFAULT 0,
                consecutive_failures INTEGER DEFAULT 0,
                rolling_avg_ms       REAL    DEFAULT 0,
                last_response_ms     INTEGER DEFAULT 0,
                difficulty           REAL    DEFAULT 0.3,
                last_seen_at         TEXT,
                fsrs_card_json       TEXT,
                PRIMARY KEY (user_id, card_id),
                FOREIGN KEY (user_id) REFERENCES users(id),
                FOREIGN KEY (card_id) REFERENCES cards(id)
            );

            CREATE TABLE IF NOT EXISTS sessions (
                id            INTEGER PRIMARY KEY,
                user_id       INTEGER NOT NULL,
                started_at    TEXT    NOT NULL,
                ended_at      TEXT,
                num_questions INTEGER,
                op            TEXT    DEFAULT 'add',
                FOREIGN KEY (user_id) REFERENCES users(id)
            );

            CREATE TABLE IF NOT EXISTS attempts (
                id                INTEGER PRIMARY KEY,
                session_id        INTEGER NOT NULL,
                user_id           INTEGER NOT NULL,
                card_id           INTEGER NOT NULL,
                a                 INTEGER NOT NULL,
                b                 INTEGER NOT NULL,
                correct_answer    INTEGER NOT NULL,
                recognized_answer INTEGER,
                response_time_ms  INTEGER NOT NULL,
                is_correct        INTEGER NOT NULL,
                is_slow           INTEGER DEFAULT 0,
                created_at        TEXT    NOT NULL,
                FOREIGN KEY (session_id) REFERENCES sessions(id),
                FOREIGN KEY (user_id)    REFERENCES users(id),
                FOREIGN KEY (card_id)    REFERENCES cards(id)
            );
        """)
        # Migrate: handle old DBs that have cards without op column
        # The old schema had UNIQUE(a,b) which blocks multiplication cards
        # from being inserted. We must recreate the table properly.
        try:
            self.conn.execute("SELECT op FROM cards LIMIT 1")
        except sqlite3.OperationalError:
            # Old schema — recreate cards table with (op, a, b) unique constraint
            self.conn.executescript("""
                CREATE TABLE cards_new (
                    id  INTEGER PRIMARY KEY,
                    op  TEXT    NOT NULL DEFAULT 'add',
                    a   INTEGER NOT NULL,
                    b   INTEGER NOT NULL,
                    UNIQUE(op, a, b)
                );
                INSERT INTO cards_new (id, op, a, b)
                    SELECT id, 'add', a, b FROM cards;
                DROP TABLE cards;
                ALTER TABLE cards_new RENAME TO cards;
            """)

        # Even if op column exists, check if old UNIQUE(a,b) constraint
        # is still present (blocks multiplication inserts). Fix by recreating.
        # We detect this by trying to insert a test mul card that overlaps
        # with an existing add card.
        test_add = self.conn.execute(
            "SELECT id FROM cards WHERE op='add' AND a=1 AND b=1"
        ).fetchone()
        if test_add:
            # Try inserting a mul card with same (a,b) — if it fails,
            # the old constraint is blocking us
            try:
                self.conn.execute(
                    "INSERT INTO cards(op, a, b) VALUES('mul_test', 1, 1)"
                )
                # Worked — delete the test row, constraint is fine
                self.conn.execute(
                    "DELETE FROM cards WHERE op='mul_test'"
                )
                self.conn.commit()
            except sqlite3.IntegrityError:
                # Old UNIQUE(a,b) is blocking — recreate table
                self.conn.executescript("""
                    CREATE TABLE cards_new (
                        id  INTEGER PRIMARY KEY,
                        op  TEXT    NOT NULL DEFAULT 'add',
                        a   INTEGER NOT NULL,
                        b   INTEGER NOT NULL,
                        UNIQUE(op, a, b)
                    );
                    INSERT INTO cards_new (id, op, a, b)
                        SELECT id, op, a, b FROM cards;
                    DROP TABLE cards;
                    ALTER TABLE cards_new RENAME TO cards;
                """)

        # Migrate: add op column to sessions if missing
        try:
            self.conn.execute("SELECT op FROM sessions LIMIT 1")
        except sqlite3.OperationalError:
            self.conn.execute("ALTER TABLE sessions ADD COLUMN op TEXT DEFAULT 'add'")

        # Migrate: add fluency columns to user_card_state if missing
        fluency_columns = [
            ("state",                "TEXT    DEFAULT 'learning'"),
            ("consecutive_correct",  "INTEGER DEFAULT 0"),
            ("consecutive_fast",     "INTEGER DEFAULT 0"),
            ("consecutive_failures", "INTEGER DEFAULT 0"),
            ("rolling_avg_ms",       "REAL    DEFAULT 0"),
            ("last_response_ms",     "INTEGER DEFAULT 0"),
            ("difficulty",           "REAL    DEFAULT 0.3"),
            ("last_seen_at",         "TEXT"),
            ("fsrs_card_json",       "TEXT"),
        ]
        for col_name, col_def in fluency_columns:
            try:
                self.conn.execute(f"SELECT {col_name} FROM user_card_state LIMIT 1")
            except sqlite3.OperationalError:
                self.conn.execute(
                    f"ALTER TABLE user_card_state ADD COLUMN {col_name} {col_def}"
                )

        self.conn.commit()

    def _seed_data(self):
        c = self.conn.cursor()
        for name in ("Miles", "Violet", "Dat'eeee'--eee"):
            c.execute("INSERT OR IGNORE INTO users(name) VALUES(?)", (name,))
        # Addition: 1-9 + 1-9
        for a in range(1, 10):
            for b in range(1, 10):
                c.execute(
                    "INSERT OR IGNORE INTO cards(op, a, b) VALUES('add', ?, ?)",
                    (a, b),
                )
        # Subtraction: 1-10 - 1-10 (where a > b to avoid zero/negative results)
        for a in range(1, 11):
            for b in range(1, a):  # b < a to ensure positive result (no zeros)
                c.execute(
                    "INSERT OR IGNORE INTO cards(op, a, b) VALUES('sub', ?, ?)",
                    (a, b),
                )
        # Multiplication: 2-15 × 2-15
        for a in range(2, 16):
            for b in range(2, 16):
                c.execute(
                    "INSERT OR IGNORE INTO cards(op, a, b) VALUES('mul', ?, ?)",
                    (a, b),
                )
        self.conn.commit()

    # ── Users ───────────────────────────────────────────────────────────

    def get_users(self):
        with self._lock:
            return self.conn.execute("SELECT * FROM users ORDER BY name").fetchall()

    def get_user_by_name(self, name):
        with self._lock:
            return self.conn.execute("SELECT * FROM users WHERE name=?", (name,)).fetchone()

    def add_user(self, name):
        """Add a new user to the database."""
        with self._lock:
            c = self.conn.cursor()
            c.execute("INSERT INTO users(name) VALUES(?)", (name,))
            self.conn.commit()
            return c.lastrowid

    def delete_user(self, user_id):
        """Delete a user and all their data from the database."""
        with self._lock:
            # Delete all user's fluency states
            self.conn.execute("DELETE FROM user_card_state WHERE user_id = ?", (user_id,))
            # Delete all user's sessions and associated attempts
            session_ids = self.conn.execute(
                "SELECT id FROM sessions WHERE user_id = ?", (user_id,)
            ).fetchall()
            for session_id in session_ids:
                self.conn.execute("DELETE FROM attempts WHERE session_id = ?", (session_id[0],))
            self.conn.execute("DELETE FROM sessions WHERE user_id = ?", (user_id,))
            # Finally, delete the user
            self.conn.execute("DELETE FROM users WHERE id = ?", (user_id,))
            self.conn.commit()

    # ── Cards ───────────────────────────────────────────────────────────

    def get_all_cards(self, op=None):
        with self._lock:
            if op:
                return self.conn.execute(
                    "SELECT * FROM cards WHERE op=? ORDER BY a, b", (op,)
                ).fetchall()
            return self.conn.execute("SELECT * FROM cards ORDER BY op, a, b").fetchall()

    def get_cards_by_ids(self, card_ids):
        if not card_ids:
            return []
        with self._lock:
            placeholders = ",".join("?" * len(card_ids))
            return self.conn.execute(
                f"SELECT * FROM cards WHERE id IN ({placeholders}) ORDER BY a, b",
                card_ids,
            ).fetchall()

    def get_card(self, op, a, b):
        with self._lock:
            return self.conn.execute(
                "SELECT * FROM cards WHERE op=? AND a=? AND b=?", (op, a, b)
            ).fetchone()

    def get_card_by_id(self, card_id):
        with self._lock:
            return self.conn.execute("SELECT * FROM cards WHERE id=?", (card_id,)).fetchone()

    # ── User-Card State (FSRS + fluency metrics) ─────────────────────────

    def get_user_card_state(self, user_id, card_id):
        with self._lock:
            return self.conn.execute(
                "SELECT * FROM user_card_state WHERE user_id=? AND card_id=?",
                (user_id, card_id),
            ).fetchone()

    def get_user_card_states_for_cards(self, user_id, card_ids):
        if not card_ids:
            return []
        with self._lock:
            placeholders = ",".join("?" * len(card_ids))
            return self.conn.execute(
                f"SELECT * FROM user_card_state WHERE user_id=? AND card_id IN ({placeholders})",
                [user_id] + list(card_ids),
            ).fetchall()

    def get_all_user_card_states(self, user_id):
        with self._lock:
            return self.conn.execute(
                "SELECT * FROM user_card_state WHERE user_id=?", (user_id,)
            ).fetchall()

    def upsert_user_card_state(
        self, user_id, card_id, ease_factor, interval_days, repetitions, due_timestamp
    ):
        with self._lock:
            self.conn.execute(
                """
                INSERT INTO user_card_state
                    (user_id, card_id, ease_factor, interval_days, repetitions, due_timestamp)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(user_id, card_id) DO UPDATE SET
                    ease_factor   = excluded.ease_factor,
                    interval_days = excluded.interval_days,
                    repetitions   = excluded.repetitions,
                    due_timestamp = excluded.due_timestamp
                """,
                (user_id, card_id, ease_factor, interval_days, repetitions, due_timestamp),
            )
            self.conn.commit()

    def increment_card_stats(self, user_id, card_id, is_correct, time_ms):
        with self._lock:
            self.conn.execute(
                """
                INSERT INTO user_card_state (user_id, card_id)
                VALUES (?, ?)
                ON CONFLICT(user_id, card_id) DO NOTHING
                """,
                (user_id, card_id),
            )
            self.conn.execute(
                """
                UPDATE user_card_state SET
                    total_attempts = total_attempts + 1,
                    total_correct  = total_correct  + ?,
                    total_time_ms  = total_time_ms  + ?
                WHERE user_id=? AND card_id=?
                """,
                (int(is_correct), time_ms, user_id, card_id),
            )
            self.conn.commit()

    def upsert_fluency_state(self, user_id, card_id, s: dict):
        """Save full fluency state for a card. Called after each review."""
        with self._lock:
            self.conn.execute(
                """
                INSERT INTO user_card_state (
                    user_id, card_id, state, total_attempts, total_correct,
                    consecutive_correct, consecutive_fast, consecutive_failures,
                    rolling_avg_ms, last_response_ms, difficulty,
                    interval_days, due_timestamp, last_seen_at, fsrs_card_json,
                    total_time_ms
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                          COALESCE((SELECT total_time_ms FROM user_card_state
                                    WHERE user_id=? AND card_id=?), 0) + ?)
                ON CONFLICT(user_id, card_id) DO UPDATE SET
                    state                = excluded.state,
                    total_attempts       = excluded.total_attempts,
                    total_correct        = excluded.total_correct,
                    consecutive_correct  = excluded.consecutive_correct,
                    consecutive_fast     = excluded.consecutive_fast,
                    consecutive_failures = excluded.consecutive_failures,
                    rolling_avg_ms       = excluded.rolling_avg_ms,
                    last_response_ms     = excluded.last_response_ms,
                    difficulty           = excluded.difficulty,
                    interval_days        = excluded.interval_days,
                    due_timestamp        = excluded.due_timestamp,
                    last_seen_at         = excluded.last_seen_at,
                    fsrs_card_json       = excluded.fsrs_card_json,
                    total_time_ms        = total_time_ms + ?
                """,
                (
                    user_id, card_id,
                    s.get("state", "learning"),
                    s.get("total_attempts", 0),
                    s.get("total_correct", 0),
                    s.get("consecutive_correct", 0),
                    s.get("consecutive_fast", 0),
                    s.get("consecutive_failures", 0),
                    s.get("rolling_avg_ms", 0),
                    s.get("last_response_ms", 0),
                    s.get("difficulty", 0.3),
                    s.get("interval_days", 0),
                    s.get("due_timestamp"),
                    s.get("last_seen_at"),
                    s.get("fsrs_card_json"),
                    user_id, card_id,  # for the subquery
                    s.get("last_response_ms", 0),  # add to total_time_ms (INSERT)
                    s.get("last_response_ms", 0),  # add to total_time_ms (UPDATE)
                ),
            )
            self.conn.commit()

    def delete_user_fluency_states(self, user_id):
        """Delete all fluency states for a user (reset their learning progress)."""
        with self._lock:
            self.conn.execute(
                "DELETE FROM user_card_state WHERE user_id = ?", (user_id,)
            )
            self.conn.commit()

    # ── Sessions ────────────────────────────────────────────────────────

    def create_session(self, user_id, num_questions, op="add"):
        with self._lock:
            c = self.conn.cursor()
            c.execute(
                "INSERT INTO sessions(user_id, started_at, num_questions, op) VALUES(?, ?, ?, ?)",
                (user_id, datetime.now().isoformat(), num_questions, op),
            )
            self.conn.commit()
            return c.lastrowid

    def end_session(self, session_id):
        with self._lock:
            self.conn.execute(
                "UPDATE sessions SET ended_at=? WHERE id=?",
                (datetime.now().isoformat(), session_id),
            )
            self.conn.commit()

    def get_user_sessions(self, user_id):
        with self._lock:
            return self.conn.execute(
                """
                SELECT s.*,
                    COUNT(a.id)            AS total_attempts,
                    COALESCE(SUM(a.is_correct), 0) AS total_correct,
                    COALESCE(AVG(a.response_time_ms), 0) AS avg_time_ms
                FROM sessions s
                LEFT JOIN attempts a ON a.session_id = s.id
                WHERE s.user_id = ?
                GROUP BY s.id
                ORDER BY s.started_at DESC
                """,
                (user_id,),
            ).fetchall()

    def delete_session(self, session_id):
        """Delete a session and all its attempts."""
        with self._lock:
            # First delete all attempts for this session
            self.conn.execute("DELETE FROM attempts WHERE session_id = ?", (session_id,))
            # Then delete the session itself
            self.conn.execute("DELETE FROM sessions WHERE id = ?", (session_id,))
            self.conn.commit()

    def get_all_sessions_for_user(self, user_id):
        """Get all sessions for a user in chronological order (oldest first)."""
        with self._lock:
            return self._get_all_sessions_for_user_unlocked(user_id)

    def _get_all_sessions_for_user_unlocked(self, user_id):
        """Internal version without lock - use when lock is already held."""
        return self.conn.execute(
            """
            SELECT * FROM sessions
            WHERE user_id = ?
            ORDER BY started_at ASC
            """,
            (user_id,),
        ).fetchall()

    def get_attempts_for_session(self, session_id):
        """Get all attempts for a session in order."""
        with self._lock:
            return self._get_attempts_for_session_unlocked(session_id)

    def _get_attempts_for_session_unlocked(self, session_id):
        """Internal version without lock - use when lock is already held."""
        return self.conn.execute(
            "SELECT * FROM attempts WHERE session_id = ? ORDER BY created_at ASC",
            (session_id,),
        ).fetchall()

    def recalculate_user_card_states(self, user_id):
        """Recalculate all card states for a user by replaying all their sessions.

        This is used after deleting a session to rebuild the spaced repetition
        algorithm state based on the remaining history.
        """
        from fluency import (
            grade_response, update_card_state, default_card_state, state_from_db_row,
            LEARNING, REVIEWING, MASTERED,
        )

        with self._lock:
            # First, clear all existing card states for this user
            self.conn.execute("DELETE FROM user_card_state WHERE user_id = ?", (user_id,))
            self.conn.commit()

            # Get all sessions in chronological order (use unlocked version)
            sessions = self._get_all_sessions_for_user_unlocked(user_id)

            # Replay each session's attempts in order
            for session in sessions:
                session_id = session["id"]
                session_op = session["op"]
                attempts = self._get_attempts_for_session_unlocked(session_id)

                for attempt in attempts:
                    card_id = attempt["card_id"]
                    a = attempt["a"]
                    b = attempt["b"]
                    correct_answer = attempt["correct_answer"]
                    response_time_ms = attempt["response_time_ms"]
                    is_correct = bool(attempt["is_correct"])

                    # Get current card state or create default
                    row = self.conn.execute(
                        "SELECT * FROM user_card_state WHERE user_id=? AND card_id=?",
                        (user_id, card_id),
                    ).fetchone()

                    if row:
                        state = state_from_db_row(row)
                    else:
                        state = default_card_state()

                    # Grade the response
                    grade = grade_response(is_correct, response_time_ms)

                    # Update state based on grade
                    reviewed_at = datetime.fromisoformat(attempt["created_at"])
                    updated_state = update_card_state(
                        state, grade, response_time_ms, now=reviewed_at
                    )

                    # Save updated state (direct SQL to avoid lock recursion)
                    self.conn.execute(
                        """
                        INSERT INTO user_card_state (
                            user_id, card_id, state, total_attempts, total_correct,
                            consecutive_correct, consecutive_fast, consecutive_failures,
                            rolling_avg_ms, last_response_ms, difficulty,
                            interval_days, due_timestamp, last_seen_at, total_time_ms,
                            ease_factor, repetitions, fsrs_card_json
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        ON CONFLICT(user_id, card_id) DO UPDATE SET
                            state                = excluded.state,
                            total_attempts       = excluded.total_attempts,
                            total_correct        = excluded.total_correct,
                            consecutive_correct  = excluded.consecutive_correct,
                            consecutive_fast     = excluded.consecutive_fast,
                            consecutive_failures = excluded.consecutive_failures,
                            rolling_avg_ms       = excluded.rolling_avg_ms,
                            last_response_ms     = excluded.last_response_ms,
                            difficulty           = excluded.difficulty,
                            interval_days        = excluded.interval_days,
                            due_timestamp        = excluded.due_timestamp,
                            last_seen_at         = excluded.last_seen_at,
                            total_time_ms        = total_time_ms + excluded.last_response_ms,
                            ease_factor          = excluded.ease_factor,
                            repetitions          = excluded.repetitions,
                            fsrs_card_json       = excluded.fsrs_card_json
                        """,
                        (
                            user_id, card_id,
                            updated_state.get("state", "learning"),
                            updated_state.get("total_attempts", 0),
                            updated_state.get("total_correct", 0),
                            updated_state.get("consecutive_correct", 0),
                            updated_state.get("consecutive_fast", 0),
                            updated_state.get("consecutive_failures", 0),
                            updated_state.get("rolling_avg_ms", 0),
                            updated_state.get("last_response_ms", 0),
                            updated_state.get("difficulty", 0.3),
                            updated_state.get("interval_days", 0),
                            updated_state.get("due_timestamp"),
                            updated_state.get("last_seen_at"),
                            updated_state.get("total_time_ms", 0),
                            updated_state.get("ease_factor", 2.5),
                            updated_state.get("repetitions", 0),
                            updated_state.get("fsrs_card_json"),
                        ),
                    )

            self.conn.commit()

    # ── Attempts ────────────────────────────────────────────────────────

    def log_attempt(
        self, session_id, user_id, card_id, a, b, correct_answer,
        recognized_answer, response_time_ms, is_correct, is_slow,
    ):
        with self._lock:
            c = self.conn.cursor()
            c.execute(
                """
                INSERT INTO attempts
                    (session_id, user_id, card_id, a, b, correct_answer,
                     recognized_answer, response_time_ms, is_correct, is_slow, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    session_id, user_id, card_id, a, b, correct_answer,
                    recognized_answer, response_time_ms,
                    int(is_correct), int(is_slow),
                    datetime.now().isoformat(),
                ),
            )
            self.conn.commit()
            return c.lastrowid

    def get_session_attempts(self, session_id):
        with self._lock:
            return self.conn.execute(
                "SELECT * FROM attempts WHERE session_id=? ORDER BY created_at",
                (session_id,),
            ).fetchall()

    def get_session(self, session_id):
        with self._lock:
            return self.conn.execute(
                "SELECT * FROM sessions WHERE id=?", (session_id,)
            ).fetchone()

    # ── Mastery Score ──────────────────────────────────────────────────

    def compute_mastery_score(self, user_id, op="mul"):
        """Compute a 0–1000 mastery score for a user on a given operation.

        Each fact contributes up to (1000 / total_facts) points.
        - Mastered + rolling_avg ≤ 1500ms → full points
        - Partial credit for non-mastered facts based on:
            accuracy  (60%): total_correct / total_attempts
            speed     (25%): linear scale 1500ms=1.0 → 5000ms=0.0
            consistency(15%): consecutive_correct / 5, capped at 1.0
        - Unattempted facts → 0 points

        Returns: (score, total_facts, mastered_count, attempted_count)
        """
        with self._lock:
            # Get all cards for this operation
            cards = self.conn.execute(
                "SELECT id FROM cards WHERE op=?", (op,)
            ).fetchall()
            total_facts = len(cards)
            if total_facts == 0:
                return (0, 0, 0, 0)

            card_ids = [c["id"] for c in cards]

            # Get user states for these cards
            placeholders = ",".join("?" * len(card_ids))
            states = self.conn.execute(
                f"SELECT * FROM user_card_state WHERE user_id=? AND card_id IN ({placeholders})",
                [user_id] + card_ids,
            ).fetchall()

            state_map = {row["card_id"]: row for row in states}

            points_per_fact = 1000.0 / total_facts
            total_score = 0.0
            mastered_count = 0
            attempted_count = 0

            for cid in card_ids:
                row = state_map.get(cid)
                if row is None or row["total_attempts"] == 0:
                    continue

                attempted_count += 1
                state = row["state"] or "learning"
                rolling_avg = row["rolling_avg_ms"] or 0
                total_attempts = row["total_attempts"] or 0
                total_correct = row["total_correct"] or 0
                consec_correct = row["consecutive_correct"] or 0

                # Determine if card should be considered "mastered" for display purposes
                # A card is considered mastered if:
                # 1. It's in "mastered" state in DB, OR
                # 2. It meets performance thresholds (high accuracy, good speed, consistency)
                is_display_mastered = (state == "mastered")
                
                # Additionally, consider a card "mastered" for display if it has:
                # - High accuracy (≥90% correct)
                # - Reasonable speed (rolling_avg ≤ 2000ms)
                # - Good consistency (at least 3 consecutive correct)
                accuracy = total_correct / total_attempts if total_attempts > 0 else 0
                if (not is_display_mastered and 
                    accuracy >= 0.90 and 
                    rolling_avg <= 2000 and 
                    consec_correct >= 3):
                    is_display_mastered = True

                if is_display_mastered:
                    mastered_count += 1
                    # Award points based on performance
                    if rolling_avg <= 1500:
                        total_score += points_per_fact
                    else:
                        # Still award partial points based on accuracy, speed, and consistency
                        # Accuracy component (60%)
                        accuracy = total_correct / total_attempts if total_attempts > 0 else 0
                        
                        # Speed component (25%): ≤1500ms → 1.0, ≥5000ms → 0.0
                        if rolling_avg <= 1500:
                            speed = 1.0
                        elif rolling_avg >= 5000:
                            speed = 0.0
                        else:
                            speed = 1.0 - (rolling_avg - 1500) / 3500

                        # Consistency component (15%): consec_correct / 5, max 1.0
                        consistency = min(consec_correct / 5.0, 1.0)

                        partial = (0.60 * accuracy) + (0.25 * speed) + (0.15 * consistency)
                        total_score += points_per_fact * partial
                else:
                    # Not considered mastered for display - calculate partial score normally
                    # Accuracy component (60%)
                    accuracy = total_correct / total_attempts if total_attempts > 0 else 0

                    # Speed component (25%): ≤1500ms → 1.0, ≥5000ms → 0.0
                    if rolling_avg <= 1500:
                        speed = 1.0
                    elif rolling_avg >= 5000:
                        speed = 0.0
                    else:
                        speed = 1.0 - (rolling_avg - 1500) / 3500

                    # Consistency component (15%): consec_correct / 5, max 1.0
                    consistency = min(consec_correct / 5.0, 1.0)

                    partial = (0.60 * accuracy) + (0.25 * speed) + (0.15 * consistency)
                    total_score += points_per_fact * partial

            return (round(total_score), total_facts, mastered_count, attempted_count)

    def close(self):
        with self._lock:
            self.conn.close()
