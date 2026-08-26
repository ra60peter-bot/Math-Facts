"""Legacy SM-2 helper retained for old integrations; the app uses FSRS."""

from datetime import datetime, timedelta


class SM2:
    """SuperMemo-2 algorithm for scheduling flashcard reviews."""

    @staticmethod
    def quality_score(is_correct: bool, is_slow: bool) -> int:
        """Map attempt outcome to SM-2 quality score (0-5).

        - incorrect        → 1
        - correct but slow → 3
        - correct and fast → 5
        """
        if not is_correct:
            return 1
        return 3 if is_slow else 5

    @staticmethod
    def update(ease_factor: float, interval_days: float,
               repetitions: int, quality: int):
        """Apply one SM-2 update step.

        Returns (new_ease_factor, new_interval_days, new_repetitions, due_timestamp_iso).
        """
        # Update ease factor (applies regardless of quality)
        ef = ease_factor + (0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02))
        ef = max(1.3, ef)

        if quality < 3:
            # Failed — reset
            repetitions = 0
            interval_days = 0.0  # Due immediately (next session)
        else:
            if repetitions == 0:
                interval_days = 1.0
            elif repetitions == 1:
                interval_days = 6.0
            else:
                interval_days = interval_days * ef
            repetitions += 1

        due = datetime.now() + timedelta(days=interval_days)
        return ef, interval_days, repetitions, due.isoformat()
