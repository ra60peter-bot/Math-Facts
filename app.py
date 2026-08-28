"""Math Flashcard App — main application and UI screens."""

import sys
import time
import random
import statistics
from datetime import datetime
from collections import deque

from app_paths import seed_user_file
from PySide6.QtCore import Qt, QTimer, Signal, QThread, QObject
from PySide6.QtGui import QFont, QColor, QPalette, QIntValidator
from PySide6.QtWidgets import (
    QApplication, QMainWindow, QWidget, QStackedWidget,
    QVBoxLayout, QHBoxLayout, QGridLayout, QFormLayout,
    QLabel, QPushButton, QComboBox, QSpinBox, QLineEdit,
    QTableWidget, QTableWidgetItem, QHeaderView,
    QProgressBar, QFrame, QSizePolicy, QMessageBox, QScrollArea,
    QCheckBox, QButtonGroup, QDialog, QListWidget, QInputDialog,
)

from database import Database
from fluency import (
    Grade, FluencyConfig, LEARNING, REVIEWING, MASTERED,
    grade_response, update_card_state, compute_priority, compute_retry_gap,
    default_card_state, state_from_db_row,
)
from speech_engine import (
    SpeechEngine, parse_number, VALID_ANSWERS, number_to_phrases,
    load_voice_profiles, save_voice_profiles,
)


# ════════════════════════════════════════════════════════════════════════
#  Time-based feedback messages
# ════════════════════════════════════════════════════════════════════════

def get_time_feedback(elapsed_ms):
    """Get motivational feedback message based on answer time in milliseconds."""
    elapsed_sec = elapsed_ms / 1000.0

    if elapsed_ms > 1500:
        return f"Keep Trying! {elapsed_sec:.1f}s"
    else:
        return None  # Return None for times 1500ms or faster


# ════════════════════════════════════════════════════════════════════════
#  Speech listener worker (runs on QThread)
# ════════════════════════════════════════════════════════════════════════

class ListenWorker(QObject):
    """Runs speech recognition on a background thread."""
    finished = Signal(str, float)  # recognized text, detection_timestamp (-1 if none)

    def __init__(self, engine: SpeechEngine, timeout: float = 6.0):
        super().__init__()
        self.engine = engine
        self.timeout = timeout

    def run(self):
        self.engine.start_listening(timeout_sec=self.timeout)
        text, detection_time = self.engine.get_result(timeout=self.timeout + 2)
        self.finished.emit(text or "", detection_time if detection_time else -1.0)


# ════════════════════════════════════════════════════════════════════════
#  Card scheduler — combines FSRS across-session + within-session retry
# ════════════════════════════════════════════════════════════════════════

class CardScheduler:
    """Fluency-based card scheduler.

    Uses FSRS due dates and retrievability as the primary priority:
      - due FSRS reviews come first
      - new cards come next
      - future FSRS reviews come last
      - fluency difficulty and speed break ties within those groups
      - Within-session retries for AGAIN/HARD responses

    Queue is pre-built from priority scores, padded to reach the
    requested question count, then retries are injected dynamically.
    """

    def __init__(self, db, user_id, num_questions, card_ids, op="add", is_retest=False):
        self.db = db
        self.user_id = user_id
        self.num_questions = num_questions
        self.op = op
        self.cfg = FluencyConfig()
        self.is_retest = is_retest

        self._queue = []
        self._retry_buffer = []
        self._shown_count = 0
        self._retry_counts = {}   # card_id → session retry count
        self._last_card_id = None  # track last shown card to prevent repeats

        self._build_queue(card_ids)

    def _build_queue(self, card_ids):
        """Build queue ordered by priority score, padded to num_questions.

        Each card can appear multiple times (padded to fill the session),
        but never back-to-back. The padding shuffles each cycle to vary order.
        """
        all_cards = self.db.get_cards_by_ids(card_ids)
        states = {
            row["card_id"]: row
            for row in self.db.get_user_card_states_for_cards(self.user_id, card_ids)
        }

        # Score each card
        scored = []
        for card in all_cards:
            cid = card["id"]
            row = states.get(cid)
            state = state_from_db_row(row) if row else default_card_state()
            priority = compute_priority(state, self.cfg)
            priority *= random.uniform(0.85, 1.15)
            scored.append((priority, card["id"], card["a"], card["b"]))

        scored.sort(key=lambda x: x[0], reverse=True)
        base_items = [(cid, a, b) for _, cid, a, b in scored]

        if not base_items:
            self._queue = []
            return

        # Pad to num_questions by cycling with shuffled copies
        queue_items = list(base_items)
        while len(queue_items) < self.num_questions:
            extra = list(base_items)
            random.shuffle(extra)
            queue_items.extend(extra)
        queue_items = queue_items[:self.num_questions]

        # Remove any back-to-back duplicates created by padding boundaries
        if len(base_items) > 1:
            cleaned = [queue_items[0]]
            for item in queue_items[1:]:
                if item[0] == cleaned[-1][0]:
                    # Same card_id as previous — swap with next different one
                    swapped = False
                    for j in range(len(cleaned) + 1, len(queue_items)):
                        if j < len(queue_items) and queue_items[j][0] != item[0]:
                            # Swap
                            cleaned.append(queue_items[j])
                            queue_items[j] = item
                            swapped = True
                            break
                    if not swapped:
                        cleaned.append(item)  # can't avoid it (only 1 card)
                else:
                    cleaned.append(item)
            queue_items = cleaned

        self._queue = queue_items

    @property
    def remaining(self):
        return max(0, self.num_questions - self._shown_count)

    @property
    def progress(self):
        return self._shown_count

    def compute_answer(self, a, b):
        if self.op == "mul":
            return a * b
        elif self.op == "sub":
            return a - b
        return a + b

    def next_card(self):
        """Return (card_id, a, b) or None if session is over.

        Hard stops at num_questions — never exceeds the chosen count.
        Never returns the same card_id twice in a row.
        """
        # Hard stop — never exceed the chosen question count
        if self._shown_count >= self.num_questions:
            return None

        # Check retry buffer first (AGAIN/HARD cards due for retry)
        for i, (trigger, cid, a, b) in enumerate(self._retry_buffer):
            if self._shown_count >= trigger and cid != self._last_card_id:
                self._retry_buffer.pop(i)
                self._shown_count += 1
                self._last_card_id = cid
                return (cid, a, b)

        # Pop from main queue, skipping if same as last shown
        attempts = 0
        while self._queue and attempts < len(self._queue):
            if self._queue[0][0] != self._last_card_id:
                item = self._queue.pop(0)
                self._shown_count += 1
                self._last_card_id = item[0]
                return item
            else:
                self._queue.append(self._queue.pop(0))
                attempts += 1

        # If all remaining are the same card, serve it anyway
        if self._queue:
            item = self._queue.pop(0)
            self._shown_count += 1
            self._last_card_id = item[0]
            return item

        # Last resort: retry buffer without duplicate guard
        for i, (trigger, cid, a, b) in enumerate(self._retry_buffer):
            if self._shown_count >= trigger:
                self._retry_buffer.pop(i)
                self._shown_count += 1
                self._last_card_id = cid
                return (cid, a, b)

        return None

    def record_response(self, card_id, grade):
        """Handle within-session retry scheduling based on grade.

        Retries replace future question slots — they do NOT add
        extra questions beyond the chosen session size.
        """
        retries = self._retry_counts.get(card_id, 0)
        gap = compute_retry_gap(grade, retries, self.cfg)

        if gap > 0:
            self._retry_counts[card_id] = retries + 1
            card = self.db.get_card_by_id(card_id)
            if card:
                trigger_at = self._shown_count + gap
                self._retry_buffer.append(
                    (trigger_at, card_id, card["a"], card["b"])
                )


# ════════════════════════════════════════════════════════════════════════
#  Styles
# ════════════════════════════════════════════════════════════════════════

STYLE_SHEET = """
QMainWindow { background-color: #1a1a2e; }
QWidget { color: #e0e0e0; font-family: 'Segoe UI', Arial, sans-serif; }
QLabel { color: #e0e0e0; }
/* Highlighted labels like "User" and "Questions" */
QLabel {
    color: #e0e0e0;
    font-weight: bold;
}
QLabel[accessibleName="highlighted-label"] {
    color: #53a8b6; /* Brighter blue for better contrast */
    font-size: 28px;
    font-weight: bold;
}
QPushButton {
    background-color: #16213e; color: #e0e0e0; border: 2px solid #0f3460;
    border-radius: 10px; padding: 7px 36px; font-size: 30px; font-weight: bold;  /* Height halved: 14px->7px */
}
QPushButton:hover { background-color: #0f3460; border-color: #53a8b6; }
QPushButton:pressed { background-color: #53a8b6; }
QPushButton#startBtn {
    background-color: #0f3460; border-color: #53a8b6;
    font-size: 40px; padding: 10px 60px;  /* Height halved: 20px->10px */
}
QPushButton#startBtn:hover { background-color: #53a8b6; color: #1a1a2e; }
QPushButton#stopBtn { background-color: #5c2020; border-color: #e94560; }
QPushButton#stopBtn:hover { background-color: #e94560; }
QPushButton#opBtn {
    font-size: 26px; padding: 5px 30px; min-width: 220px;  /* Height halved: 10px->5px */
}
QPushButton#opBtnActive {
    font-size: 26px; padding: 5px 30px; min-width: 220px;  /* Height halved: 10px->5px */
    background-color: #53a8b6; color: #1a1a2e; border-color: #53a8b6;
}
QComboBox, QSpinBox, QLineEdit {
    background-color: #16213e; color: #e0e0e0; border: 2px solid #0f3460;
    border-radius: 8px; padding: 12px; font-size: 30px;
}
QComboBox:hover, QSpinBox:hover, QLineEdit:hover { border-color: #53a8b6; }
QSpinBox::up-button {
    subcontrol-origin: border; subcontrol-position: top right;
    width: 40px; border-left: 2px solid #0f3460; border-top-right-radius: 6px;
    background-color: #0f3460; /* Changed to make it more visible */
    margin: 2px 2px 0px 0px; /* Added margin to separate from down button */
}
QSpinBox::down-button {
    subcontrol-origin: border; subcontrol-position: bottom right;
    width: 40px; border-left: 2px solid #0f3460; border-bottom-right-radius: 6px;
    background-color: #0f3460; /* Changed to make it more visible */
    margin: 0px 2px 2px 0px; /* Added margin to separate from up button */
}
QSpinBox::up-arrow, QSpinBox::down-arrow {
    width: 14px;
    height: 14px;
    /* Making arrows more visible */
    subcontrol-position: center;
    image: none;
}
QSpinBox::up-arrow {
    /* Triangle pointing up */
    subcontrol-position: center;
    border: 3px solid transparent;
    border-bottom: 3px solid #e0e0e0; /* Arrow color */
    height: 8px;
    width: 10px;
}
QSpinBox::down-arrow {
    /* Triangle pointing down */
    subcontrol-position: center;
    border: 3px solid transparent;
    border-top: 3px solid #e0e0e0; /* Arrow color */
    height: 8px;
    width: 10px;
}
QSpinBox::up-button:hover, QSpinBox::down-button:hover {
    background-color: #53a8b6;
}
QComboBox QAbstractItemView {
    background-color: #16213e; color: #e0e0e0;
    selection-background-color: #0f3460; font-size: 28px;
}
QProgressBar {
    border: 2px solid #0f3460; border-radius: 8px; text-align: center;
    color: #e0e0e0; font-size: 24px; font-weight: bold;
}
QProgressBar::chunk { background-color: #53a8b6; border-radius: 6px; }
QTableWidget {
    background-color: #16213e; color: #e0e0e0; gridline-color: #0f3460;
    border: 1px solid #0f3460; border-radius: 8px; font-size: 26px;
}
QTableWidget::item { padding: 8px 12px; }
QHeaderView::section {
    background-color: #0f3460; color: #e0e0e0; padding: 10px;
    border: 1px solid #16213e; font-weight: bold; font-size: 26px;
}
QFrame#card {
    background-color: #16213e; border: 4px solid #0f3460; border-radius: 24px;
}
QScrollArea { border: none; background-color: transparent; }
QCheckBox { spacing: 6px; font-size: 22px; }
QCheckBox::indicator { width: 28px; height: 28px; }
QCheckBox::indicator:unchecked {
    border: 2px solid #0f3460; border-radius: 4px; background-color: #16213e;
}
QCheckBox::indicator:checked {
    border: 2px solid #53a8b6; border-radius: 4px; background-color: #53a8b6;
}
/* Dialog boxes */
QMessageBox {
    background-color: #1a1a2e;
    color: #e0e0e0;
}
QMessageBox QLabel {
    color: #e0e0e0;
    font-size: 16px;
}
QMessageBox QPushButton {
    background-color: #0f3460;
    color: #e0e0e0;
    border: 1px solid #53a8b6;
    padding: 8px 24px;
    font-size: 14px;
    min-width: 80px;
}
QMessageBox QPushButton:hover {
    background-color: #53a8b6;
    color: #1a1a2e;
}
QDialog {
    background-color: #1a1a2e;
    color: #e0e0e0;
}
QInputDialog {
    background-color: #1a1a2e;
    color: #e0e0e0;
}
QInputDialog QLabel {
    color: #e0e0e0;
    font-size: 16px;
}
QInputDialog QLineEdit {
    background-color: #16213e;
    color: #e0e0e0;
    border: 1px solid #0f3460;
    padding: 6px;
    font-size: 16px;
}
"""


# ════════════════════════════════════════════════════════════════════════
#  Number Grid Widget (like the uploaded image)
# ════════════════════════════════════════════════════════════════════════

class NumberGridWidget(QWidget):
    """Checkbox grid for selecting which number pairs to include.

    Each row and column gets its own ✓ (select all) and ✗ (clear all) buttons,
    plus global Select All / Clear All at the bottom.
    """

    MINI_BTN = "font-size:16px; padding:2px 6px; min-width:28px; max-width:32px; border-radius:4px;"

    def __init__(self, op="add"):
        super().__init__()
        self.op = op
        self.checkboxes = {}  # (a, b) → QCheckBox
        self.nums = []
        self._exclude_equal = (op == "sub")  # For subtraction, exclude a=b cases
        self._build_grid()

    def _build_grid(self):
        if self.op == "add":
            self.nums = list(range(1, 10))       # 1-9
        elif self.op == "sub":
            self.nums = list(range(1, 11))       # 1-10
        else:
            self.nums = list(range(2, 16))       # 2-15

        nums = self.nums
        n = len(nums)
        layout = QGridLayout(self)
        layout.setSpacing(4)

        header_font = QFont("Segoe UI", 14, QFont.Bold)  # Reduced from 18 to 14 (20% smaller)

        # ── Column headers (row 0) ──
        # col 0 = row label area, cols 1..n = number columns,
        # col n+1 = row ✓, col n+2 = row ✗
        corner = QLabel("")
        layout.addWidget(corner, 0, 0)

        for j, num in enumerate(nums):
            lbl = QLabel(str(num))
            lbl.setFont(header_font)
            lbl.setAlignment(Qt.AlignCenter)
            lbl.setStyleSheet("color: #53a8b6;")
            layout.addWidget(lbl, 0, j + 1)

        # Row ✓/✗ header labels
        lbl_sel = QLabel("✓")
        lbl_sel.setFont(QFont("Segoe UI", 11, QFont.Bold))  # Reduced from 14 to 11 (20% smaller)
        lbl_sel.setAlignment(Qt.AlignCenter)
        lbl_sel.setStyleSheet("color: #4ec9b0;")
        layout.addWidget(lbl_sel, 0, n + 1)

        lbl_clr = QLabel("✗")
        lbl_clr.setFont(QFont("Segoe UI", 11, QFont.Bold))  # Reduced from 14 to 11 (20% smaller)
        lbl_clr.setAlignment(Qt.AlignCenter)
        lbl_clr.setStyleSheet("color: #e94560;")
        layout.addWidget(lbl_clr, 0, n + 2)

        # ── Rows: header + checkboxes + row ✓/✗ buttons ──
        for i, a in enumerate(nums):
            # Row header
            lbl = QLabel(str(a))
            lbl.setFont(header_font)
            lbl.setAlignment(Qt.AlignCenter)
            lbl.setStyleSheet("color: #53a8b6;")
            layout.addWidget(lbl, i + 1, 0)

            # Checkboxes
            for j, b in enumerate(nums):
                cb = QCheckBox()
                cb.setChecked(True)
                cb.setStyleSheet("spacing: 4px;")  # Reduced from default
                
                # For subtraction, disable checkboxes where a == b (would result in 0)
                if self._exclude_equal and a == b:
                    cb.setEnabled(False)
                    cb.setToolTip("Excluded (result would be 0)")
                
                layout.addWidget(cb, i + 1, j + 1, Qt.AlignCenter)
                self.checkboxes[(a, b)] = cb

            # Row select-all button
            btn_row_sel = QPushButton("✓")
            btn_row_sel.setStyleSheet("font-size:13px; padding:2px 5px; min-width:22px; max-width:26px; border-radius:3px; color: #4ec9b0; border: 1px solid #4ec9b0;")  # Updated MINI_BTN to be 20% smaller
            row_a = a  # capture
            btn_row_sel.clicked.connect(lambda checked=False, r=row_a: self._set_row(r, True))
            layout.addWidget(btn_row_sel, i + 1, n + 1, Qt.AlignCenter)

            # Row clear-all button
            btn_row_clr = QPushButton("✗")
            btn_row_clr.setStyleSheet("font-size:13px; padding:2px 5px; min-width:22px; max-width:26px; border-radius:3px; color: #e94560; border: 1px solid #e94560;")  # Updated MINI_BTN to be 20% smaller
            btn_row_clr.clicked.connect(lambda checked=False, r=row_a: self._set_row(r, False))
            layout.addWidget(btn_row_clr, i + 1, n + 2, Qt.AlignCenter)

        # ── Column ✓/✗ buttons (bottom row) ──
        bot_row = n + 1
        # Empty cell under row headers
        layout.addWidget(QLabel(""), bot_row, 0)

        for j, b in enumerate(nums):
            col_container = QWidget()
            col_lay = QHBoxLayout(col_container)
            col_lay.setContentsMargins(0, 0, 0, 0)
            col_lay.setSpacing(2)

            btn_col_sel = QPushButton("✓")
            btn_col_sel.setStyleSheet("font-size:13px; padding:2px 5px; min-width:22px; max-width:26px; border-radius:3px; color: #4ec9b0; border: 1px solid #4ec9b0;")  # Updated MINI_BTN to be 20% smaller
            col_b = b  # capture
            btn_col_sel.clicked.connect(lambda checked=False, c=col_b: self._set_col(c, True))
            col_lay.addWidget(btn_col_sel)

            btn_col_clr = QPushButton("✗")
            btn_col_clr.setStyleSheet("font-size:13px; padding:2px 5px; min-width:22px; max-width:26px; border-radius:3px; color: #e94560; border: 1px solid #e94560;")  # Updated MINI_BTN to be 20% smaller
            btn_col_clr.clicked.connect(lambda checked=False, c=col_b: self._set_col(c, False))
            col_lay.addWidget(btn_col_clr)

            layout.addWidget(col_container, bot_row, j + 1, Qt.AlignCenter)

        # ── Global Select All / Clear All ──
        global_row = n + 2
        global_container = QHBoxLayout()
        global_container.setAlignment(Qt.AlignCenter)
        global_container.setSpacing(13)  # Reduced from 16 to 13 (20% smaller)

        btn_all = QPushButton("✓ Select All")
        btn_all.setStyleSheet("font-size: 16px; padding: 5px 13px;")  # Reduced from 20px font and 6px 16px padding
        btn_all.clicked.connect(lambda: self._set_all(True))
        global_container.addWidget(btn_all)

        btn_none = QPushButton("✗ Clear All")
        btn_none.setStyleSheet("font-size: 16px; padding: 5px 13px;")  # Reduced from 20px font and 6px 16px padding
        btn_none.clicked.connect(lambda: self._set_all(False))
        global_container.addWidget(btn_none)

        layout.addLayout(global_container, global_row, 0, 1, n + 3)

    def _set_row(self, a, checked):
        """Select or clear all checkboxes in a row (all columns for this row number)."""
        for b in self.nums:
            cb = self.checkboxes.get((a, b))
            if cb:
                cb.setChecked(checked)

    def _set_col(self, b, checked):
        """Select or clear all checkboxes in a column (all rows for this column number)."""
        for a in self.nums:
            cb = self.checkboxes.get((a, b))
            if cb:
                cb.setChecked(checked)

    def _set_all(self, checked):
        for cb in self.checkboxes.values():
            cb.setChecked(checked)

    def get_selected_pairs(self):
        """Return list of (a, b) tuples that are checked.

        Column = first operand (a), Row = second operand (b).
        So checkbox at (row, col) maps to fact (col, row) = col × row.
        """
        return [(col, row) for (row, col), cb in self.checkboxes.items() if cb.isChecked() and cb.isEnabled()]


# ════════════════════════════════════════════════════════════════════════
#  Setup Screen
# ════════════════════════════════════════════════════════════════════════

class SetupScreen(QWidget):
    start_session = Signal(str, int, str, list)  # user, num, op, [(a,b),...]
    show_history = Signal()
    show_dictionary = Signal()
    show_user_management = Signal()

    def __init__(self, db, speech):
        super().__init__()
        self.db = db
        self.speech = speech
        self.current_op = "add"
        self._build_ui()

    def _build_ui(self):
        outer = QVBoxLayout(self)
        outer.setContentsMargins(20, 10, 20, 10)

        # Create a layout that will be used inside the scroll area
        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        content = QWidget()
        layout = QVBoxLayout(content)
        layout.setSpacing(16)

        # ── Mastery Score Display (horizontal bar at the top, full width, half height) ──
        mastery_frame = QFrame()
        mastery_frame.setStyleSheet(
            "QFrame { background-color: #16213e; border: 2px solid #0f3460; "
            "border-radius: 16px; padding: 8px; margin-bottom: 16px; }"  # Reduced padding to make it half height
        )
        
        mastery_layout = QHBoxLayout(mastery_frame)  # Changed to horizontal layout
        mastery_layout.setSpacing(12)  # Reduced spacing

        # Mastery title
        self.lbl_mastery_title = QLabel("🏆  Mastery Score")
        self.lbl_mastery_title.setFont(QFont("Segoe UI", 18, QFont.Bold))  # Reduced font size
        self.lbl_mastery_title.setStyleSheet("color: #e9a845; border: none;")
        mastery_layout.addWidget(self.lbl_mastery_title)

        # Mastery score
        self.lbl_mastery_score = QLabel("— / 1000")
        self.lbl_mastery_score.setFont(QFont("Segoe UI", 24, QFont.Bold))  # Reduced font size
        self.lbl_mastery_score.setStyleSheet("color: #ffffff; border: none;")
        mastery_layout.addWidget(self.lbl_mastery_score)

        # Mastery bar
        self.mastery_bar = QProgressBar()
        self.mastery_bar.setRange(0, 1000)
        self.mastery_bar.setValue(0)
        self.mastery_bar.setMinimumHeight(18)  # Reduced height to make it half height
        self.mastery_bar.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Preferred)  # Allow it to expand to fill available space
        self.mastery_bar.setStyleSheet("""
            QProgressBar {
                border: 2px solid #0f3460; border-radius: 6px;
                text-align: center; color: #e0e0e0;
                font-size: 14px; font-weight: bold;
                background-color: #1a1a2e;
            }
            QProgressBar::chunk { background-color: #e9a845; border-radius: 4px; }
        """)
        mastery_layout.addWidget(self.mastery_bar)

        # Mastery detail
        self.lbl_mastery_detail = QLabel("")
        self.lbl_mastery_detail.setFont(QFont("Segoe UI", 14))  # Reduced font size
        self.lbl_mastery_detail.setStyleSheet("color: #8888aa; border: none;")
        mastery_layout.addWidget(self.lbl_mastery_detail)
        
        # Add the mastery frame (full width) to the main layout
        layout.addWidget(mastery_frame)

        # Title
        title = QLabel("🧮  Math Flashcards")
        title.setFont(QFont("Segoe UI", 48, QFont.Bold))  # Reduced from 60 to 48 (20% smaller)
        title.setAlignment(Qt.AlignCenter)
        title.setStyleSheet("color: #53a8b6;")
        layout.addWidget(title)

        subtitle = QLabel("Addition & Multiplication Practice")
        subtitle.setFont(QFont("Segoe UI", 22, QFont.Bold))  # Reduced from 28 to 22 (20% smaller)
        subtitle.setAlignment(Qt.AlignCenter)
        subtitle.setStyleSheet("color: #8888aa;")
        layout.addWidget(subtitle)

        # ── Operation toggle ──
        op_row = QHBoxLayout()
        op_row.setAlignment(Qt.AlignCenter)
        op_row.setSpacing(12)  # Reduced from 16 to 12 (20% smaller)

        self.btn_add = QPushButton("➕  Addition")
        self.btn_add.setObjectName("opBtnActive")
        self.btn_add.setFont(QFont("Segoe UI", 20, QFont.Bold))  # Added font size
        self.btn_add.clicked.connect(lambda: self._set_op("add"))
        op_row.addWidget(self.btn_add)

        self.btn_sub = QPushButton("➖  Subtraction")
        self.btn_sub.setObjectName("opBtn")
        self.btn_sub.setFont(QFont("Segoe UI", 20, QFont.Bold))  # Added font size
        self.btn_sub.clicked.connect(lambda: self._set_op("sub"))
        op_row.addWidget(self.btn_sub)

        self.btn_mul = QPushButton("✖  Multiplication")
        self.btn_mul.setObjectName("opBtn")
        self.btn_mul.setFont(QFont("Segoe UI", 20, QFont.Bold))  # Added font size
        self.btn_mul.clicked.connect(lambda: self._set_op("mul"))
        op_row.addWidget(self.btn_mul)

        layout.addLayout(op_row)

        # ── User + question count (side by side) ──
        user_question_row = QHBoxLayout()
        user_question_row.setSpacing(20)  # Space between the user and questions sections

        # User section
        user_section = QHBoxLayout()
        user_section.setSpacing(10)  # Space between label and combobox
        lbl_user = QLabel("User:")
        lbl_user.setFont(QFont("Segoe UI", 22, QFont.Bold))  # Reduced from 28 to 22 (20% smaller)
        lbl_user.setProperty("accessibleName", "highlighted-label")  # Apply highlighting
        self.combo_user = QComboBox()
        self.combo_user.setMinimumWidth(240)  # Reduced from 300 to 240 (20% smaller)
        self.combo_user.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Preferred)
        self.combo_user.setFont(QFont("Segoe UI", 18))  # Added font size
        for u in self.db.get_users():
            self.combo_user.addItem(u["name"])
        user_section.addWidget(lbl_user)
        user_section.addWidget(self.combo_user)
        
        # Questions section
        questions_section = QHBoxLayout()
        questions_section.setSpacing(10)  # Space between label and spinbox
        lbl_num = QLabel("Questions:")
        lbl_num.setFont(QFont("Segoe UI", 22, QFont.Bold))  # Reduced from 28 to 22 (20% smaller)
        lbl_num.setProperty("accessibleName", "highlighted-label")  # Apply highlighting
        self.spin_num = QSpinBox()
        self.spin_num.setRange(10, 100)
        self.spin_num.setValue(50)
        self.spin_num.setSingleStep(10)
        self.spin_num.setMinimumWidth(240)  # Reduced from 300 to 240 (20% smaller)
        self.spin_num.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Preferred)
        self.spin_num.setFont(QFont("Segoe UI", 18))  # Added font size
        questions_section.addWidget(lbl_num)
        questions_section.addWidget(self.spin_num)

        # Add both sections to the main row
        user_question_row.addLayout(user_section)
        user_question_row.addLayout(questions_section)

        layout.addLayout(user_question_row)

        # Connect user/op changes to refresh score
        self.combo_user.currentTextChanged.connect(self._refresh_mastery_score)

        # ── Number grid label ──
        self.grid_label = QLabel("Select which facts to practice:")
        self.grid_label.setFont(QFont("Segoe UI", 19, QFont.Bold))  # Reduced from 24 to 19 (20% smaller)
        self.grid_label.setAlignment(Qt.AlignCenter)
        self.grid_label.setStyleSheet("color: #aaaacc;")
        layout.addWidget(self.grid_label)

        # ── Number grid (stacked: one for add, sub, mul) ──
        self.grid_stack = QStackedWidget()

        self.add_grid = NumberGridWidget("add")
        self.sub_grid = NumberGridWidget("sub")
        self.mul_grid = NumberGridWidget("mul")

        self.grid_stack.addWidget(self.add_grid)  # 0
        self.grid_stack.addWidget(self.sub_grid)  # 1
        self.grid_stack.addWidget(self.mul_grid)  # 2
        self.grid_stack.setCurrentIndex(0)

        layout.addWidget(self.grid_stack)

        # Mic status
        self.mic_label = QLabel()
        self.mic_label.setFont(QFont("Segoe UI", 18, QFont.Bold))  # Reduced from 22 to 18 (20% smaller)
        self.mic_label.setAlignment(Qt.AlignCenter)
        self.mic_label.setWordWrap(True)
        if self.speech.available:
            mic_ok = self.speech.test_microphone()
            if mic_ok:
                self.mic_label.setText("🎤  Microphone ready")
                self.mic_label.setStyleSheet("color: #4ec9b0;")
            else:
                self.mic_label.setText("⚠️  Microphone not detected — keyboard fallback active")
                self.mic_label.setStyleSheet("color: #e9a845;")
        else:
            self.mic_label.setText("⚠️  Vosk not available — keyboard-only mode")
            self.mic_label.setStyleSheet("color: #e9a845;")
        layout.addWidget(self.mic_label)

        # Buttons
        btn_row = QHBoxLayout()
        btn_row.setAlignment(Qt.AlignCenter)
        btn_row.setSpacing(19)  # Reduced from 24 to 19 (20% smaller)

        self.btn_start = QPushButton("▶  Start Practice")
        self.btn_start.setObjectName("startBtn")
        self.btn_start.setFont(QFont("Segoe UI", 24, QFont.Bold))  # Reduced font size
        self.btn_start.setSizePolicy(QSizePolicy.Preferred, QSizePolicy.Preferred)
        self.btn_start.clicked.connect(self._on_start)
        btn_row.addWidget(self.btn_start)

        self.btn_history = QPushButton("📊  History")
        self.btn_history.setFont(QFont("Segoe UI", 24, QFont.Bold))  # Reduced font size
        self.btn_history.setSizePolicy(QSizePolicy.Preferred, QSizePolicy.Preferred)
        self.btn_history.clicked.connect(self.show_history.emit)
        btn_row.addWidget(self.btn_history)

        self.btn_dictionary = QPushButton("📖  Dictionary")
        self.btn_dictionary.setFont(QFont("Segoe UI", 24, QFont.Bold))  # Reduced font size
        self.btn_dictionary.setSizePolicy(QSizePolicy.Preferred, QSizePolicy.Preferred)
        self.btn_dictionary.clicked.connect(self._show_dictionary)
        btn_row.addWidget(self.btn_dictionary)

        self.btn_manage_users = QPushButton("👤  Manage Users")
        self.btn_manage_users.setFont(QFont("Segoe UI", 24, QFont.Bold))  # Reduced font size
        self.btn_manage_users.setSizePolicy(QSizePolicy.Preferred, QSizePolicy.Preferred)
        self.btn_manage_users.clicked.connect(self._show_user_management)
        btn_row.addWidget(self.btn_manage_users)

        layout.addLayout(btn_row)
        layout.addStretch()

        scroll.setWidget(content)
        outer.addWidget(scroll)

        # Initial mastery score load
        QTimer.singleShot(0, self._refresh_mastery_score)

    def _set_op(self, op):
        self.current_op = op
        if op == "add":
            self.btn_add.setObjectName("opBtnActive")
            self.btn_sub.setObjectName("opBtn")
            self.btn_mul.setObjectName("opBtn")
            self.grid_stack.setCurrentIndex(0)
        elif op == "sub":
            self.btn_add.setObjectName("opBtn")
            self.btn_sub.setObjectName("opBtnActive")
            self.btn_mul.setObjectName("opBtn")
            self.grid_stack.setCurrentIndex(1)
        else:
            self.btn_add.setObjectName("opBtn")
            self.btn_sub.setObjectName("opBtn")
            self.btn_mul.setObjectName("opBtnActive")
            self.grid_stack.setCurrentIndex(2)
        # Force style refresh
        self.btn_add.style().unpolish(self.btn_add)
        self.btn_add.style().polish(self.btn_add)
        self.btn_sub.style().unpolish(self.btn_sub)
        self.btn_sub.style().polish(self.btn_sub)
        self.btn_mul.style().unpolish(self.btn_mul)
        self.btn_mul.style().polish(self.btn_mul)
        self._refresh_mastery_score()

    def _refresh_mastery_score(self):
        """Update the mastery score display for current user and operation."""
        user_name = self.combo_user.currentText()
        if not user_name:
            return
        user = self.db.get_user_by_name(user_name)
        if not user:
            return
        op = self.current_op
        score, total_facts, mastered, attempted = self.db.compute_mastery_score(
            user["id"], op
        )
        if op == "mul":
            op_label = "Multiplication"
        elif op == "sub":
            op_label = "Subtraction"
        else:
            op_label = "Addition"
        self.lbl_mastery_title.setText(f"🏆  {op_label} Mastery Score")
        self.lbl_mastery_score.setText(f"{score} / 1000")
        self.mastery_bar.setValue(score)

        # Color the score based on level
        if score >= 900:
            color = "#4ec9b0"  # green
        elif score >= 600:
            color = "#e9a845"  # gold
        elif score >= 300:
            color = "#53a8b6"  # blue
        else:
            color = "#e0e0e0"  # white/grey
        self.lbl_mastery_score.setStyleSheet(f"color: {color}; border: none;")

        # Debugging: Print the values to see what's happening
        print(f"[DEBUG] User: {user_name}, Op: {op}, Score: {score}, Total: {total_facts}, Mastered: {mastered}, Attempted: {attempted}")

        self.lbl_mastery_detail.setText(
            f"{mastered} of {total_facts} facts mastered  •  "
            f"{attempted} of {total_facts} attempted"
        )

    def _on_start(self):
        user = self.combo_user.currentText()
        num = self.spin_num.value()
        op = self.current_op

        grid = self.add_grid if op == "add" else self.mul_grid
        selected = grid.get_selected_pairs()

        if not selected:
            QMessageBox.warning(self, "No Facts Selected",
                                "Please select at least one fact in the grid.")
            return

        self.start_session.emit(user, num, op, selected)

    def _show_dictionary(self):
        self.show_dictionary.emit()

    def _show_user_management(self):
        self.show_user_management.emit()


# ════════════════════════════════════════════════════════════════════════
#  Practice Screen
# ════════════════════════════════════════════════════════════════════════

class PracticeScreen(QWidget):
    session_ended = Signal(int)

    def __init__(self, db, speech):
        super().__init__()
        self.db = db
        self.speech = speech
        self.scheduler = None
        self.session_id = None
        self.user_id = None
        self.user_name = ""
        self.op = "add"
        self._current_card = None
        self._start_time = None
        self._listen_thread = None
        self._listening = False
        self._custom_map = {}
        self._is_retest = False
        self._build_ui()

    def _build_ui(self):
        layout = QVBoxLayout(self)
        layout.setSpacing(16)
        layout.setContentsMargins(24, 16, 24, 16)

        # Top bar
        top = QHBoxLayout()
        self.lbl_progress = QLabel("0 / 0")
        self.lbl_progress.setFont(QFont("Segoe UI", 28))
        top.addWidget(self.lbl_progress)

        self.progress_bar = QProgressBar()
        self.progress_bar.setMinimumHeight(36)
        self.progress_bar.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Preferred)
        top.addWidget(self.progress_bar, 1)

        # Mastery score in top bar
        self.lbl_practice_mastery = QLabel("🏆 —")
        self.lbl_practice_mastery.setFont(QFont("Segoe UI", 24, QFont.Bold))
        self.lbl_practice_mastery.setStyleSheet("color: #e9a845;")
        self.lbl_practice_mastery.setMinimumWidth(160)
        self.lbl_practice_mastery.setAlignment(Qt.AlignCenter)
        top.addWidget(self.lbl_practice_mastery)

        self.btn_stop = QPushButton("■  Stop")
        self.btn_stop.setObjectName("stopBtn")
        self.btn_stop.setMinimumWidth(160)
        self.btn_stop.clicked.connect(self._stop_session)
        top.addWidget(self.btn_stop)

        layout.addLayout(top)
        layout.addStretch(1)

        # Card area
        self.card_frame = QFrame()
        self.card_frame.setObjectName("card")
        self.card_frame.setMinimumSize(600, 350)
        self.card_frame.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Expanding)
        self.card_frame.setMaximumHeight(600)
        card_layout = QVBoxLayout(self.card_frame)
        card_layout.setAlignment(Qt.AlignCenter)

        self.lbl_question = QLabel("")
        self.lbl_question.setFont(QFont("Segoe UI", 144, QFont.Bold))
        self.lbl_question.setAlignment(Qt.AlignCenter)
        self.lbl_question.setStyleSheet("color: #ffffff;")
        self.lbl_question.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Expanding)
        card_layout.addWidget(self.lbl_question)

        h_center = QHBoxLayout()
        h_center.addStretch(1)
        h_center.addWidget(self.card_frame, 4)
        h_center.addStretch(1)
        layout.addLayout(h_center, 3)

        # Feedback
        self.lbl_feedback = QLabel("")
        self.lbl_feedback.setFont(QFont("Segoe UI", 44, QFont.Bold))
        self.lbl_feedback.setAlignment(Qt.AlignCenter)
        self.lbl_feedback.setMinimumHeight(60)
        self.lbl_feedback.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Preferred)
        layout.addWidget(self.lbl_feedback)

        self.lbl_heard = QLabel("")
        self.lbl_heard.setFont(QFont("Segoe UI", 26))
        self.lbl_heard.setAlignment(Qt.AlignCenter)
        self.lbl_heard.setStyleSheet("color: #666688;")
        layout.addWidget(self.lbl_heard)

        # ── Pronunciation acceptance (shown on wrong answers) ───────────
        self.accept_row = QWidget()
        accept_layout = QHBoxLayout(self.accept_row)
        accept_layout.setAlignment(Qt.AlignCenter)
        accept_layout.setSpacing(12)
        accept_layout.setContentsMargins(0, 0, 0, 0)

        self.cb_accept = QCheckBox("")
        self.cb_accept.setFont(QFont("Segoe UI", 20))
        self.cb_accept.setStyleSheet("color: #e9a845;")
        accept_layout.addWidget(self.cb_accept)

        self.btn_accept = QPushButton("Save pronunciation")
        self.btn_accept.setStyleSheet(
            "font-size: 18px; padding: 6px 16px; "
            "background-color: #0f3460; border-color: #e9a845; color: #e9a845;"
        )
        self.btn_accept.clicked.connect(self._on_accept_pronunciation)
        accept_layout.addWidget(self.btn_accept)

        self.btn_next_question = QPushButton("Next Question")
        self.btn_next_question.setStyleSheet(
            "font-size: 18px; padding: 6px 16px; "
            "background-color: #0f3460; border-color: #53a8b6; color: #53a8b6;"
        )
        self.btn_next_question.clicked.connect(self._on_next_question)
        accept_layout.addWidget(self.btn_next_question)

        self.accept_row.setVisible(False)
        layout.addWidget(self.accept_row)

        # Store pending pronunciation data
        self._pending_heard = None    # raw text Vosk heard
        self._pending_answer = None   # the correct answer number

        self.lbl_listening = QLabel("")
        self.lbl_listening.setFont(QFont("Segoe UI", 28))
        self.lbl_listening.setAlignment(Qt.AlignCenter)
        layout.addWidget(self.lbl_listening)

        # Dictionary to store remembered answers: {(a, b, user_answer): correct_answer}
        self._remembered_answers = {}
        self._load_remembered_answers()

        # Keyboard input
        kb_row = QHBoxLayout()
        kb_row.setAlignment(Qt.AlignCenter)
        self.txt_answer = QLineEdit()
        self.txt_answer.setPlaceholderText("Type answer + Enter")
        self.txt_answer.setMinimumWidth(300)
        self.txt_answer.setMaximumWidth(500)
        self.txt_answer.setFont(QFont("Segoe UI", 32))
        self.txt_answer.setValidator(QIntValidator(0, 200))
        self.txt_answer.returnPressed.connect(self._on_keyboard_answer)
        kb_row.addWidget(self.txt_answer)
        layout.addLayout(kb_row)

        layout.addStretch(1)

        self._feedback_timer = QTimer(self)
        self._feedback_timer.setSingleShot(True)
        self._feedback_timer.timeout.connect(self._show_next)

    def _play_reward_sound(self):
        """No-op function - sounds have been removed."""
        pass  # No sound functionality

    def begin_session(self, user_name, num_questions, op, selected_pairs, is_retest=False):
        """Initialize and start a new practice session."""
        user = self.db.get_user_by_name(user_name)
        self.user_id = user["id"]
        self.user_name = user_name
        self.op = op
        self._is_retest = is_retest
        self.session_id = self.db.create_session(self.user_id, num_questions, op)

        # Load user's custom pronunciation map (safe — won't crash)
        try:
            profiles = load_voice_profiles()
            self._custom_map = profiles.get(user_name, {})
            self.speech.set_user_grammar(user_name)
        except Exception as e:
            print(f"[Practice] Voice profile load failed (non-fatal): {e}")
            self._custom_map = {}

        # Look up card IDs for selected pairs
        card_ids = []
        for a, b in selected_pairs:
            card = self.db.get_card(op, a, b)
            if card:
                card_ids.append(card["id"])

        print(f"[Practice] Starting: user={user_name}, op={op}, "
              f"pairs={len(selected_pairs)}, cards_found={len(card_ids)}, "
              f"requested={num_questions}, retest={is_retest}")

        self.scheduler = CardScheduler(self.db, self.user_id, num_questions, card_ids, op, is_retest)

        print(f"[Practice] Queue built: {len(self.scheduler._queue)} questions")

        self.progress_bar.setMaximum(self.scheduler.num_questions)
        self.progress_bar.setValue(0)
        self.lbl_feedback.setText("")
        self.lbl_heard.setText("")

        # Show initial mastery score
        self._refresh_practice_mastery()

        # Voice works for both addition and multiplication
        self._use_voice = self.speech.available

        self._show_next()

    def _load_remembered_answers(self):
        """Load remembered answers from a file."""
        import json
        try:
            file_path = seed_user_file("remembered_answers.json")
            if file_path.exists():
                with open(file_path, 'r') as f:
                    data = json.load(f)
                    # Convert string keys back to tuples
                    self._remembered_answers = {(int(k.split(',')[0]), int(k.split(',')[1]), int(k.split(',')[2])): v 
                                               for k, v in data.items()}
            else:
                self._remembered_answers = {}
        except Exception as e:
            print(f"[Remembered Answers] Error loading remembered answers: {e}")
            self._remembered_answers = {}

    def _save_remembered_answers(self):
        """Save remembered answers to a file."""
        import json
        try:
            file_path = seed_user_file("remembered_answers.json")
            # Convert tuple keys to strings for JSON serialization
            data = {f"{k[0]},{k[1]},{k[2]}": v for k, v in self._remembered_answers.items()}
            with open(file_path, 'w') as f:
                json.dump(data, f, indent=2)
        except Exception as e:
            print(f"[Remembered Answers] Error saving remembered answers: {e}")

    def _remember_answer(self, a, b, user_answer, correct_answer):
        """Remember that user_answer for problem (a, b) should be considered correct."""
        self._remembered_answers[(a, b, user_answer)] = correct_answer
        self._save_remembered_answers()

    def _show_next(self):
        # First, flash black briefly to signal a change
        self.lbl_question.setText("")
        self.lbl_question.setStyleSheet("color: #000000;")
        self.card_frame.setStyleSheet("background-color: #000000; border: 4px solid #000000;")
        QApplication.processEvents()  # Force immediate update
        time.sleep(0.002)  # 2ms black screen
        
        # Restore normal styling
        self.card_frame.setStyleSheet("")
        self.lbl_question.setStyleSheet("color: #ffffff; font-size: 144px; font-weight: bold;")
        
        self.lbl_feedback.setText("")
        self.lbl_heard.setText("")
        self.accept_row.setVisible(False)
        self.cb_accept.setEnabled(True)
        self.cb_accept.setChecked(False)
        self.cb_accept.setStyleSheet("color: #e9a845;")
        self.btn_accept.setEnabled(True)
        self.btn_accept.setStyleSheet(
            "font-size: 18px; padding: 6px 16px; "
            "background-color: #0f3460; border-color: #e9a845; color: #e9a845;"
        )
        self.btn_next_question.setVisible(False)
        self.btn_next_question.setEnabled(False)

        card = self.scheduler.next_card()
        if card is None:
            self._finish_session()
            return

        card_id, a, b = card
        answer = self.scheduler.compute_answer(a, b)
        self._current_card = {"card_id": card_id, "a": a, "b": b, "answer": answer}

        if self.op == "mul":
            op_symbol = "×"
        elif self.op == "sub":
            op_symbol = "−"
        else:
            op_symbol = "+"
        self.lbl_question.setText(f"{a} {op_symbol} {b}")

        done = self.scheduler.progress
        total = self.scheduler.num_questions
        self.lbl_progress.setText(f"{done} / {total}")
        self.progress_bar.setMaximum(total)
        self.progress_bar.setValue(done)

        self.txt_answer.clear()
        self.txt_answer.setEnabled(True)
        self.txt_answer.setFocus()

        self._start_time = time.time()
        self._start_listening()

    def _start_listening(self):
        if not self._use_voice:
            self.lbl_listening.setText("⌨️  Type your answer")
            return

        self.lbl_listening.setText("🎤  Listening…")
        self._listening = True

        # Clean up previous thread before creating new one
        if self._listen_thread is not None and self._listen_thread.isRunning():
            self._listen_thread.quit()
            self._listen_thread.wait(1000)

        self._listen_thread = QThread(self)
        self._worker = ListenWorker(self.speech, timeout=6.0)
        self._worker.moveToThread(self._listen_thread)
        self._listen_thread.started.connect(self._worker.run)
        self._worker.finished.connect(self._on_speech_result)
        self._worker.finished.connect(self._listen_thread.quit)
        self._listen_thread.start()

    def _on_speech_result(self, text, detection_time):
        if not self._listening:
            return
        self._listening = False
        self.lbl_listening.setText("")

        if not text:
            self._process_answer(None, "(no speech detected)", None)
            return

        number = parse_number(text, self._custom_map)
        self._process_answer(number, text, detection_time if detection_time > 0 else None)

    def _on_keyboard_answer(self):
        text = self.txt_answer.text().strip()
        if not text:
            return
        self.speech.stop_listening()
        self._listening = False
        self.lbl_listening.setText("")
        try:
            number = int(text)
        except ValueError:
            number = None
        self._process_answer(number, text, None)

    def _process_answer(self, recognized_number, raw_text, detection_time=None):
        if self._current_card is None:
            return

        self.txt_answer.setEnabled(False)
        end_time = detection_time if detection_time else time.time()
        elapsed_ms = max(0, int((end_time - self._start_time) * 1000))

        card = self._current_card
        self._current_card = None

        correct_answer = card["answer"]
        # Check if this user answer has been remembered as correct for this specific problem
        is_correct = recognized_number == correct_answer
        
        # Additional check: if user gave a different answer that they've remembered as correct for this problem
        if not is_correct and recognized_number is not None and raw_text:
            # Check if this combination of (a, b, user_answer) has been remembered
            if (card["a"], card["b"], recognized_number) in self._remembered_answers:
                if self._remembered_answers[(card["a"], card["b"], recognized_number)] == correct_answer:
                    is_correct = True
                    print(f"[Remembered Answer] '{raw_text}' accepted as correct for {card['a']} {self.op} {card['b']}")

        # ── Fluency grading ─────────────────────────────────────────────
        grade = grade_response(is_correct, elapsed_ms)
        is_slow = (grade == Grade.HARD)

        # Log attempt to DB (keeps backward-compatible attempt records)
        # For retest sessions, we still log the attempt but don't update fluency states
        self.db.log_attempt(
            session_id=self.session_id, user_id=self.user_id,
            card_id=card["card_id"], a=card["a"], b=card["b"],
            correct_answer=correct_answer, recognized_answer=recognized_number,
            response_time_ms=elapsed_ms, is_correct=is_correct, is_slow=is_slow,
        )

        # ── Update fluency state ────────────────────────────────────────
        # Skip fluency updates for retest sessions - these are limited question sets
        # and shouldn't affect spaced repetition mastery tracking
        if not self._is_retest:
            db_row = self.db.get_user_card_state(self.user_id, card["card_id"])
            state = state_from_db_row(db_row) if db_row else default_card_state()
            updated = update_card_state(state, grade, elapsed_ms)
            self.db.upsert_fluency_state(self.user_id, card["card_id"], updated)

        # ── Within-session retry scheduling ─────────────────────────────
        self.scheduler.record_response(card["card_id"], grade)

        # ── Update live mastery score ────────────────────────────────────
        self._refresh_practice_mastery()

        # ── UI feedback ─────────────────────────────────────────────────
        time_str = f"{elapsed_ms / 1000:.1f}s"

        grade_labels = {
            Grade.AGAIN: ("✗", "#e94560"),
            Grade.HARD:  ("✓ Slow", "#e9a845"),
            Grade.GOOD:  ("✓ Good", "#4ec9b0"),
            Grade.EASY:  ("✓ Fast!", "#53d8c9"),
        }
        label, color = grade_labels[grade]

        if grade == Grade.AGAIN:
            self.lbl_feedback.setText(
                f"✗  Incorrect — answer is {correct_answer}  ({time_str})"
            )
        else:
            # For correct answers, check for time-based feedback
            time_feedback = get_time_feedback(elapsed_ms)
            if time_feedback:
                feedback_text = time_feedback
            else:
                feedback_text = f"{label}  ({time_str})"
            self.lbl_feedback.setText(feedback_text)
            # Reward sound functionality has been removed
        self.lbl_feedback.setStyleSheet(f"color: {color};")

        heard_display = f"Heard: \"{raw_text}\"" if raw_text else "Heard: (nothing)"
        if recognized_number is not None:
            heard_display += f"  →  {recognized_number}"
        self.lbl_heard.setText(heard_display)

        # ── Pronunciation acceptance (wrong answers only) ────────────────
        self._pending_heard = None
        self._pending_answer = None

        if grade == Grade.AGAIN and raw_text and raw_text != "(no speech detected)":
            # Show checkbox to let user accept this pronunciation
            self._pending_heard = raw_text.strip().lower()
            self._pending_answer = correct_answer
            # Store current card info for later use in accepting pronunciation
            self._current_card_for_accept = card.copy()
            self.cb_accept.setChecked(False)
            self.cb_accept.setText(
                f'Accept "{raw_text}" as {correct_answer}'
            )
            self.btn_next_question.setVisible(True)
            self.btn_next_question.setEnabled(True)  # Ensure button is enabled
            self.accept_row.setVisible(True)
            # Do NOT auto-advance — wait for user to make a choice
        else:
            self.accept_row.setVisible(False)
            self.btn_next_question.setVisible(False)
            self.btn_next_question.setEnabled(False)  # Disable when not visible
            self._feedback_timer.start(900)

    def _on_accept_pronunciation(self):
        """Save the heard text as a valid pronunciation for the correct answer."""
        if not self.cb_accept.isChecked():
            return
        if not self._pending_heard or self._pending_answer is None:
            return

        try:
            # Parse the number from the heard text
            parsed_number = parse_number(self._pending_heard, self._custom_map)
            
            # Save to voice profiles for pronunciation recognition
            profiles = load_voice_profiles()
            if self.user_name not in profiles:
                profiles[self.user_name] = {}
            profiles[self.user_name][self._pending_heard] = self._pending_answer
            save_voice_profiles(profiles)

            # Also update the in-session custom map immediately
            self._custom_map[self._pending_heard] = self._pending_answer

            # Update grammar to include this new pronunciation
            self.speech.set_user_grammar(self.user_name)

            # Remember this specific answer for this problem if it's different from the expected number
            if parsed_number is not None and parsed_number != self._pending_answer:
                # The user said something that parsed to a different number than expected
                # Remember that this specific answer should be treated as correct for this problem
                if hasattr(self, '_current_card_for_accept'):  # Use the stored card info
                    self._remember_answer(self._current_card_for_accept["a"], self._current_card_for_accept["b"], 
                                         parsed_number, self._pending_answer)

            # Turn checkbox green to indicate saved
            self.cb_accept.setText(f"✓ Saved! \"{self._pending_heard}\" → {self._pending_answer}")
            self.cb_accept.setStyleSheet("color: #4ec9b0;")
            self.cb_accept.setEnabled(False)
            self.btn_accept.setEnabled(False)
            self.btn_next_question.setEnabled(False)

            print(f"[Voice] Saved: \"{self._pending_heard}\" → {self._pending_answer} "
                  f"for {self.user_name}")
        except Exception as e:
            print(f"[Voice] Save failed: {e}")

        # Advance to next card after a brief pause
        self._feedback_timer.start(800)

    def _on_next_question(self):
        """Skip to the next question without saving the pronunciation."""
        # Hide the acceptance row and immediately show the next question
        self.accept_row.setVisible(False)
        self._show_next()  # Directly call the method to show the next question

    def _refresh_practice_mastery(self):
        """Update the live mastery score in the practice screen top bar."""
        if self.user_id is None:
            return
        score, total_facts, mastered, attempted = self.db.compute_mastery_score(
            self.user_id, self.op
        )
        if score >= 900:
            color = "#4ec9b0"
        elif score >= 600:
            color = "#e9a845"
        elif score >= 300:
            color = "#53a8b6"
        else:
            color = "#e0e0e0"
        self.lbl_practice_mastery.setText(f"🏆 {score}")
        self.lbl_practice_mastery.setStyleSheet(f"color: {color};")

    def _stop_session(self):
        self.speech.stop_listening()
        self._listening = False
        self._feedback_timer.stop()
        self._finish_session()

    def _finish_session(self):
        self.speech.stop_listening()
        self._listening = False
        self.lbl_listening.setText("")
        self.db.end_session(self.session_id)
        self.session_ended.emit(self.session_id)


# ════════════════════════════════════════════════════════════════════════
#  Results Screen
# ════════════════════════════════════════════════════════════════════════

class ResultsScreen(QWidget):
    go_home = Signal()
    view_details = Signal(int)
    start_retest = Signal(int, int)  # session_id, count — retest specified number of bottom questions

    def __init__(self, db):
        super().__init__()
        self.db = db
        self.session_id = None
        self._build_ui()

    def _build_ui(self):
        layout = QVBoxLayout(self)
        layout.setSpacing(16)
        layout.setContentsMargins(30, 20, 30, 20)

        title = QLabel("📋  Session Results")
        title.setFont(QFont("Segoe UI", 50, QFont.Bold))
        title.setAlignment(Qt.AlignCenter)
        title.setStyleSheet("color: #53a8b6;")
        layout.addWidget(title)

        self.lbl_stats = QLabel("")
        self.lbl_stats.setFont(QFont("Segoe UI", 30))
        self.lbl_stats.setAlignment(Qt.AlignCenter)
        self.lbl_stats.setWordWrap(True)
        layout.addWidget(self.lbl_stats)

        # ── Mastery Score on Results ──
        mastery_row = QHBoxLayout()
        mastery_row.setAlignment(Qt.AlignCenter)
        mastery_row.setSpacing(16)

        self.results_mastery_label = QLabel("🏆  Mastery:")
        self.results_mastery_label.setFont(QFont("Segoe UI", 28, QFont.Bold))
        self.results_mastery_label.setStyleSheet("color: #e9a845;")
        mastery_row.addWidget(self.results_mastery_label)

        self.results_mastery_score = QLabel("— / 1000")
        self.results_mastery_score.setFont(QFont("Segoe UI", 28, QFont.Bold))
        self.results_mastery_score.setStyleSheet("color: #ffffff;")
        mastery_row.addWidget(self.results_mastery_score)

        self.results_mastery_bar = QProgressBar()
        self.results_mastery_bar.setRange(0, 1000)
        self.results_mastery_bar.setValue(0)
        self.results_mastery_bar.setMinimumHeight(28)
        self.results_mastery_bar.setMinimumWidth(300)
        self.results_mastery_bar.setMaximumWidth(400)
        self.results_mastery_bar.setStyleSheet("""
            QProgressBar {
                border: 2px solid #0f3460; border-radius: 8px;
                text-align: center; color: #e0e0e0;
                font-size: 16px; font-weight: bold;
                background-color: #1a1a2e;
            }
            QProgressBar::chunk { background-color: #e9a845; border-radius: 6px; }
        """)
        mastery_row.addWidget(self.results_mastery_bar)

        self.results_mastery_detail = QLabel("")
        self.results_mastery_detail.setFont(QFont("Segoe UI", 18))
        self.results_mastery_detail.setStyleSheet("color: #8888aa;")
        mastery_row.addWidget(self.results_mastery_detail)

        layout.addLayout(mastery_row)

        # Two tables side by side
        tables_row = QHBoxLayout()
        tables_row.setSpacing(20)

        # Top 10 Best (fastest correct)
        best_col = QVBoxLayout()
        lbl_best = QLabel("⭐  Top 10 Best")
        lbl_best.setFont(QFont("Segoe UI", 26, QFont.Bold))
        lbl_best.setAlignment(Qt.AlignCenter)
        lbl_best.setStyleSheet("color: #4ec9b0;")
        best_col.addWidget(lbl_best)

        self.table_best = QTableWidget()
        self.table_best.setColumnCount(3)
        self.table_best.setHorizontalHeaderLabels(["Question", "Time", "Result"])
        self.table_best.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Expanding)

        # Set specific column widths for better readability
        header_best = self.table_best.horizontalHeader()
        header_best.setSectionResizeMode(0, QHeaderView.Stretch)          # Question - stretch to fill
        header_best.setSectionResizeMode(1, QHeaderView.ResizeToContents)  # Time - resize to content
        header_best.setSectionResizeMode(2, QHeaderView.ResizeToContents)  # Result - resize to content

        # Increase row height for better readability
        self.table_best.verticalHeader().setDefaultSectionSize(40)  # Taller rows for better readability

        # Apply styling for better readability
        self.table_best.setStyleSheet("""
            QTableWidget {
                background-color: #16213e;
                color: #e0e0e0;
                gridline-color: #0f3460;
                border: 1px solid #0f3460;
                border-radius: 8px;
                font-size: 18px; /* Reduced font size for better fit */
            }
            QTableWidget::item {
                padding: 8px 12px;
                border: 1px solid #0f3460;
                text-align: center;
            }
            QHeaderView::section {
                background-color: #0f3460;
                color: #e0e0e0;
                padding: 10px;
                border: 1px solid #16213e;
                font-weight: bold;
                font-size: 18px; /* Reduced font size */
            }
        """)

        best_col.addWidget(self.table_best)
        tables_row.addLayout(best_col)

        # Top 10 Worst (incorrect + slowest)
        worst_col = QVBoxLayout()
        lbl_worst = QLabel("⚠  Top 10 Needs Work")
        lbl_worst.setFont(QFont("Segoe UI", 26, QFont.Bold))
        lbl_worst.setAlignment(Qt.AlignCenter)
        lbl_worst.setStyleSheet("color: #e94560;")
        worst_col.addWidget(lbl_worst)

        self.table_worst = QTableWidget()
        self.table_worst.setColumnCount(4)
        self.table_worst.setHorizontalHeaderLabels(["Question", "Answer", "Time", "Result"])
        self.table_worst.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Expanding)

        # Set specific column widths for better readability
        header_worst = self.table_worst.horizontalHeader()
        header_worst.setSectionResizeMode(0, QHeaderView.Stretch)          # Question - stretch to fill
        header_worst.setSectionResizeMode(1, QHeaderView.ResizeToContents)  # Answer - resize to content
        header_worst.setSectionResizeMode(2, QHeaderView.ResizeToContents)  # Time - resize to content
        header_worst.setSectionResizeMode(3, QHeaderView.ResizeToContents)  # Result - resize to content

        # Increase row height for better readability
        self.table_worst.verticalHeader().setDefaultSectionSize(40)  # Taller rows for better readability

        # Apply styling for better readability
        self.table_worst.setStyleSheet("""
            QTableWidget {
                background-color: #16213e;
                color: #e0e0e0;
                gridline-color: #0f3460;
                border: 1px solid #0f3460;
                border-radius: 8px;
                font-size: 18px; /* Reduced font size for better fit */
            }
            QTableWidget::item {
                padding: 8px 12px;
                border: 1px solid #0f3460;
                text-align: center;
            }
            QHeaderView::section {
                background-color: #0f3460;
                color: #e0e0e0;
                padding: 10px;
                border: 1px solid #16213e;
                font-weight: bold;
                font-size: 18px; /* Reduced font size */
            }
        """)

        worst_col.addWidget(self.table_worst)
        tables_row.addLayout(worst_col)

        layout.addLayout(tables_row, 1)

        btn_row = QHBoxLayout()
        btn_row.setAlignment(Qt.AlignCenter)
        btn_row.setSpacing(24)

        # Dropdown to select number of questions to retest
        self.retest_count_combo = QComboBox()
        self.retest_count_combo.addItems(["5", "10", "15", "20", "All"])
        self.retest_count_combo.setCurrentText("10")
        self.retest_count_combo.setMinimumWidth(80)
        self.retest_count_combo.setStyleSheet(
            "background-color: #16213e; color: #e0e0e0; border: 2px solid #0f3460;"
            "border-radius: 8px; padding: 8px; font-size: 18px;"
        )
        
        self.btn_retest = QPushButton("🔁  Retest Bottom")
        self.btn_retest.setStyleSheet(
            "background-color: #0f3460; border-color: #e9a845; color: #e9a845;"
        )
        self.btn_retest.clicked.connect(
            lambda: self._emit_retest_signal()
        )
        
        # Add both widgets to the button row
        btn_row.addWidget(self.btn_retest)
        btn_row.addWidget(self.retest_count_combo)

        btn_details = QPushButton("🔍  Review All Attempts")
        btn_details.clicked.connect(lambda: self.view_details.emit(self.session_id))
        btn_row.addWidget(btn_details)
        btn_home = QPushButton("🏠  Home")
        btn_home.clicked.connect(self.go_home.emit)
        btn_row.addWidget(btn_home)
        layout.addLayout(btn_row)

    def _emit_retest_signal(self):
        """Emit retest signal with the selected count."""
        count_text = self.retest_count_combo.currentText()
        if count_text == "All":
            count = len(self._worst_card_ids)
        else:
            count = min(int(count_text), len(self._worst_card_ids))
        # Emit the signal with both session_id and count
        # We'll need to modify how this is handled in MainWindow
        self.start_retest.emit(self.session_id, count)

    def show_results(self, session_id):
        self.session_id = session_id
        attempts = self.db.get_session_attempts(session_id)
        sess = self.db.get_session(session_id)
        op = sess["op"] if sess and "op" in sess.keys() else "add"
        self._last_op = op
        if op == "mul":
            op_sym = "×"
        elif op == "sub":
            op_sym = "−"
        else:
            op_sym = "+"

        if not attempts:
            self.lbl_stats.setText("No attempts recorded.")
            self.btn_retest.setEnabled(False)
            return

        total = len(attempts)
        correct = sum(1 for a in attempts if a["is_correct"])
        times = [a["response_time_ms"] for a in attempts]
        avg_time = statistics.mean(times)
        pct = (correct / total) * 100

        if op == "mul":
            op_label = "Multiplication"
        elif op == "sub":
            op_label = "Subtraction"
        else:
            op_label = "Addition"
        self.lbl_stats.setText(
            f"{op_label}    •    Questions: {total}    •    "
            f"Correct: {correct}/{total} ({pct:.1f}%)\n"
            f"Average time: {avg_time / 1000:.2f}s"
        )

        # ── Mastery score ────────────────────────────────────────────────
        user_id = sess["user_id"]
        score, total_facts, mastered, attempted = self.db.compute_mastery_score(
            user_id, op
        )
        self.results_mastery_score.setText(f"{score} / 1000")
        self.results_mastery_bar.setValue(score)
        if score >= 900:
            color = "#4ec9b0"
        elif score >= 600:
            color = "#e9a845"
        elif score >= 300:
            color = "#53a8b6"
        else:
            color = "#e0e0e0"
        self.results_mastery_score.setStyleSheet(f"color: {color};")
        self.results_mastery_detail.setText(
            f"{mastered}/{total_facts} mastered  •  {attempted}/{total_facts} attempted"
        )

        # ── Top 10 Best: fastest correct answers ────────────────────────
        correct_attempts = [a for a in attempts if a["is_correct"]]
        correct_attempts.sort(key=lambda a: a["response_time_ms"])
        best10 = correct_attempts[:10]

        self.table_best.setRowCount(len(best10))
        for i, att in enumerate(best10):
            q = f"{att['a']} {op_sym} {att['b']}"
            t = f"{att['response_time_ms'] / 1000:.2f}s"
            res = "✓"
            for j, val in enumerate([q, t, res]):
                item = QTableWidgetItem(val)
                item.setTextAlignment(Qt.AlignCenter)
                if j == 2:
                    item.setForeground(QColor("#4ec9b0"))
                self.table_best.setItem(i, j, item)

        # ── Top 10 Worst: incorrect first, then slowest ─────────────────
        wrong = [a for a in attempts if not a["is_correct"]]
        wrong.sort(key=lambda a: a["response_time_ms"], reverse=True)
        slow_correct = [a for a in attempts if a["is_correct"]]
        slow_correct.sort(key=lambda a: a["response_time_ms"], reverse=True)
        worst_pool = wrong + slow_correct
        worst10 = worst_pool[:10]

        # Save worst card IDs for retest — deduplicate by card_id
        seen_ids = set()
        self._worst_card_ids = []
        for att in worst10:
            cid = att["card_id"]
            if cid not in seen_ids:
                seen_ids.add(cid)
                self._worst_card_ids.append(cid)

        self.btn_retest.setEnabled(len(self._worst_card_ids) > 0)

        self.table_worst.setRowCount(len(worst10))
        for i, att in enumerate(worst10):
            q = f"{att['a']} {op_sym} {att['b']}"
            ans = str(att["recognized_answer"]) if att["recognized_answer"] is not None else "—"
            t = f"{att['response_time_ms'] / 1000:.2f}s"
            if att["is_correct"]:
                res = f"✓ slow"
                color = "#e9a845"
            else:
                res = f"✗ ({att['correct_answer']})"
                color = "#e94560"
            for j, val in enumerate([q, ans, t, res]):
                item = QTableWidgetItem(val)
                item.setTextAlignment(Qt.AlignCenter)
                if j == 3:
                    item.setForeground(QColor(color))
                self.table_worst.setItem(i, j, item)


# ════════════════════════════════════════════════════════════════════════
#  Session Detail Screen
# ════════════════════════════════════════════════════════════════════════

class SessionDetailScreen(QWidget):
    go_back = Signal()

    def __init__(self, db):
        super().__init__()
        self.db = db
        self._build_ui()

    def _build_ui(self):
        layout = QVBoxLayout(self)
        layout.setSpacing(16)
        layout.setContentsMargins(24, 16, 24, 16)

        title = QLabel("📝  Session Details")
        title.setFont(QFont("Segoe UI", 44, QFont.Bold))
        title.setStyleSheet("color: #53a8b6;")
        layout.addWidget(title)

        self.table = QTableWidget()
        self.table.setColumnCount(6)
        self.table.setHorizontalHeaderLabels([
            "#", "Question", "Heard", "Correct Ans", "Time", "Result"
        ])
        self.table.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Expanding)
        
        # Set specific column widths for better readability
        header = self.table.horizontalHeader()
        header.setSectionResizeMode(0, QHeaderView.ResizeToContents)  # # - resize to content
        header.setSectionResizeMode(1, QHeaderView.Stretch)          # Question - stretch to fill
        header.setSectionResizeMode(2, QHeaderView.ResizeToContents)  # Heard - resize to content
        header.setSectionResizeMode(3, QHeaderView.ResizeToContents)  # Correct Ans - resize to content
        header.setSectionResizeMode(4, QHeaderView.ResizeToContents)  # Time - resize to content
        header.setSectionResizeMode(5, QHeaderView.ResizeToContents)  # Result - resize to content
        
        # Increase row height for better readability
        self.table.verticalHeader().setDefaultSectionSize(40)  # Taller rows for better readability
        
        # Apply styling for better readability
        self.table.setStyleSheet("""
            QTableWidget {
                background-color: #16213e;
                color: #e0e0e0;
                gridline-color: #0f3460;
                border: 1px solid #0f3460;
                border-radius: 8px;
                font-size: 18px; /* Reduced font size for better fit */
            }
            QTableWidget::item {
                padding: 8px 12px;
                border: 1px solid #0f3460;
                text-align: center;
            }
            QHeaderView::section {
                background-color: #0f3460;
                color: #e0e0e0;
                padding: 10px;
                border: 1px solid #16213e;
                font-weight: bold;
                font-size: 18px; /* Reduced font size */
            }
        """)
        
        layout.addWidget(self.table)

        btn = QPushButton("← Back")
        btn.setMinimumWidth(200)
        btn.clicked.connect(self.go_back.emit)
        layout.addWidget(btn)

    def show_session(self, session_id):
        attempts = self.db.get_session_attempts(session_id)
        sess = self.db.get_session(session_id)
        op = sess["op"] if sess and "op" in sess.keys() else "add"
        if op == "mul":
            op_sym = "×"
        elif op == "sub":
            op_sym = "−"
        else:
            op_sym = "+"

        self.table.setRowCount(len(attempts))
        for i, att in enumerate(attempts):
            vals = [
                str(i + 1),
                f"{att['a']} {op_sym} {att['b']}",
                str(att["recognized_answer"]) if att["recognized_answer"] is not None else "—",
                str(att["correct_answer"]),
                f"{att['response_time_ms'] / 1000:.2f}s",
                "✓" if att["is_correct"] else "✗",
            ]
            for j, val in enumerate(vals):
                item = QTableWidgetItem(val)
                item.setTextAlignment(Qt.AlignCenter)
                if j == 5:
                    item.setForeground(
                        QColor("#4ec9b0") if att["is_correct"] else QColor("#e94560")
                    )
                self.table.setItem(i, j, item)
        self.table.resizeColumnsToContents()


# ════════════════════════════════════════════════════════════════════════
#  History Screen
# ════════════════════════════════════════════════════════════════════════

class HistoryScreen(QWidget):
    go_home = Signal()
    view_session = Signal(int)
    delete_session = Signal(int)

    def __init__(self, db):
        super().__init__()
        self.db = db
        self._build_ui()

    def _build_ui(self):
        layout = QVBoxLayout(self)
        layout.setSpacing(16)
        layout.setContentsMargins(24, 16, 24, 16)

        top = QHBoxLayout()
        title = QLabel("📊  Practice History")
        title.setFont(QFont("Segoe UI", 44, QFont.Bold))
        title.setStyleSheet("color: #53a8b6;")
        top.addWidget(title)
        top.addStretch()

        self.combo_user = QComboBox()
        self.combo_user.setMinimumWidth(280)
        for u in self.db.get_users():
            self.combo_user.addItem(u["name"])
        self.combo_user.currentTextChanged.connect(self._refresh)
        top.addWidget(self.combo_user)
        layout.addLayout(top)

        self.lbl_trend = QLabel("")
        self.lbl_trend.setFont(QFont("Segoe UI", 28))
        self.lbl_trend.setWordWrap(True)
        self.lbl_trend.setStyleSheet("color: #aaaacc;")
        layout.addWidget(self.lbl_trend)

        self.table = QTableWidget()
        self.table.setColumnCount(8)
        self.table.setHorizontalHeaderLabels([
            "Date", "Type", "Questions", "Correct", "% Correct", "Avg Time", "Details", "Delete"
        ])
        self.table.setSelectionBehavior(QTableWidget.SelectRows)
        self.table.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Expanding)

        # Set specific column widths for better readability
        header = self.table.horizontalHeader()
        header.setSectionResizeMode(0, QHeaderView.Interactive)     # Date - set manually
        header.setSectionResizeMode(1, QHeaderView.ResizeToContents)  # Type - resize to content
        header.setSectionResizeMode(2, QHeaderView.ResizeToContents)  # Questions - resize to content
        header.setSectionResizeMode(3, QHeaderView.ResizeToContents)  # Correct - resize to content
        header.setSectionResizeMode(4, QHeaderView.ResizeToContents)  # % Correct - resize to content
        header.setSectionResizeMode(5, QHeaderView.ResizeToContents)  # Avg Time - resize to content
        header.setSectionResizeMode(6, QHeaderView.Stretch)          # Details - stretch to fill
        header.setSectionResizeMode(7, QHeaderView.ResizeToContents)  # Delete - resize to content

        # Set minimum widths to ensure readability
        self.table.setColumnWidth(0, 150)  # Date column - wider to accommodate full date
        self.table.setColumnWidth(1, 80)   # Type column
        self.table.setColumnWidth(2, 100)  # Questions column
        self.table.setColumnWidth(3, 100)  # Correct column
        self.table.setColumnWidth(4, 100)  # % Correct column
        self.table.setColumnWidth(5, 100)  # Avg Time column
        
        # Increase row height for better readability
        self.table.verticalHeader().setDefaultSectionSize(40)  # Taller rows for better readability
        
        # Apply styling for better readability
        self.table.setStyleSheet("""
            QTableWidget {
                background-color: #16213e;
                color: #e0e0e0;
                gridline-color: #0f3460;
                border: 1px solid #0f3460;
                border-radius: 8px;
                font-size: 18px; /* Reduced font size for better fit */
            }
            QTableWidget::item {
                padding: 8px 12px;
                border: 1px solid #0f3460;
                text-align: center;
            }
            QHeaderView::section {
                background-color: #0f3460;
                color: #e0e0e0;
                padding: 10px;
                border: 1px solid #16213e;
                font-weight: bold;
                font-size: 18px; /* Reduced font size */
            }
        """)
        
        layout.addWidget(self.table)

        btn = QPushButton("🏠  Home")
        btn.setMinimumWidth(200)
        btn.clicked.connect(self.go_home.emit)
        layout.addWidget(btn)

    def refresh_for_user(self, user_name):
        idx = self.combo_user.findText(user_name)
        if idx >= 0:
            self.combo_user.setCurrentIndex(idx)
        self._refresh()

    def _refresh(self):
        user_name = self.combo_user.currentText()
        user = self.db.get_user_by_name(user_name)
        if not user:
            return

        sessions = self.db.get_user_sessions(user["id"])
        self.table.setRowCount(len(sessions))

        accuracies = []
        times = []

        for i, sess in enumerate(sessions):
            total = sess["total_attempts"] or 0
            correct = sess["total_correct"] or 0
            avg_ms = sess["avg_time_ms"] or 0
            pct = (correct / total * 100) if total > 0 else 0.0
            op = sess["op"] if "op" in sess.keys() else "add"
            if op == "mul":
                op_label = "×  Mul"
            elif op == "sub":
                op_label = "−  Sub"
            else:
                op_label = "+  Add"

            accuracies.append(pct)
            times.append(avg_ms)

            date_str = ""
            if sess["started_at"]:
                try:
                    dt = datetime.fromisoformat(sess["started_at"])
                    date_str = dt.strftime("%Y-%m-%d %H:%M")
                except ValueError:
                    date_str = sess["started_at"][:16]

            vals = [
                date_str, op_label, str(total), str(correct),
                f"{pct:.1f}%",
                f"{avg_ms / 1000:.2f}s" if avg_ms else "—",
                "",
            ]
            for j, val in enumerate(vals):
                item = QTableWidgetItem(val)
                item.setTextAlignment(Qt.AlignCenter)
                self.table.setItem(i, j, item)

            btn = QPushButton("View")
            btn.setMinimumWidth(100)
            sid = sess["id"]
            btn.clicked.connect(lambda checked=False, s=sid: self.view_session.emit(s))
            self.table.setCellWidget(i, 6, btn)

            del_btn = QPushButton("🗑️ Delete")
            del_btn.setMinimumWidth(100)
            del_btn.setStyleSheet("background-color: #5c2020; border-color: #e94560;")
            del_sid = sess["id"]
            del_btn.clicked.connect(lambda checked=False, s=del_sid: self.delete_session.emit(s))
            self.table.setCellWidget(i, 7, del_btn)

        self.table.resizeColumnsToContents()

        if len(sessions) >= 4:
            half = len(sessions) // 2
            recent_acc = statistics.mean(accuracies[:half]) if accuracies[:half] else 0
            older_acc = statistics.mean(accuracies[half:]) if accuracies[half:] else 0
            recent_time = statistics.mean(times[:half]) if times[:half] else 0
            older_time = statistics.mean(times[half:]) if times[half:] else 0
            acc_delta = recent_acc - older_acc
            time_delta = (recent_time - older_time) / 1000
            acc_arrow = "📈" if acc_delta > 0 else "📉" if acc_delta < 0 else "➡️"
            time_arrow = "📈" if time_delta < 0 else "📉" if time_delta > 0 else "➡️"
            self.lbl_trend.setText(
                f"Improvement trend (recent {half} vs earlier {len(sessions) - half} sessions):\n"
                f"  {acc_arrow} Accuracy: {acc_delta:+.1f}%    "
                f"  {time_arrow} Speed: {time_delta:+.2f}s"
            )
        elif len(sessions) > 0:
            self.lbl_trend.setText(
                f"{len(sessions)} session(s) recorded. "
                "Complete 4+ sessions to see improvement trends."
            )
        else:
            self.lbl_trend.setText("No sessions yet for this user.")


# ════════════════════════════════════════════════════════════════════════
#  Custom Dictionary Editor Screen
# ════════════════════════════════════════════════════════════════════════

class CustomDictionaryEditor(QWidget):
    go_home = Signal()

    def __init__(self, db, speech, default_user=None):
        super().__init__()
        self.db = db
        self.speech = speech
        self.current_user = None
        self.default_user = default_user
        self._build_ui()

    def _build_ui(self):
        layout = QVBoxLayout(self)
        layout.setSpacing(16)
        layout.setContentsMargins(24, 16, 24, 16)

        # Title
        title = QLabel("📖  Custom Dictionary Editor")
        title.setFont(QFont("Segoe UI", 44, QFont.Bold))
        title.setStyleSheet("color: #53a8b6;")
        layout.addWidget(title)

        # User selection
        user_selection_layout = QHBoxLayout()
        user_selection_layout.addWidget(QLabel("Select User:"))
        self.user_combo = QComboBox()
        self.user_combo.setMinimumWidth(280)
        for u in self.db.get_users():
            self.user_combo.addItem(u["name"])
        self.user_combo.currentTextChanged.connect(self._on_user_changed)
        user_selection_layout.addWidget(self.user_combo)
        layout.addLayout(user_selection_layout)

        # Dictionary table
        self.table = QTableWidget()
        self.table.setColumnCount(3)
        self.table.setHorizontalHeaderLabels(["#", "Spoken Text", "Maps To Number"])
        self.table.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Expanding)
        
        # Enable row selection
        self.table.setSelectionBehavior(QTableWidget.SelectRows)
        self.table.setSelectionMode(QTableWidget.SingleSelection)

        # Set column widths: first column smaller, middle column wider, last column medium
        header = self.table.horizontalHeader()
        header.setSectionResizeMode(0, QHeaderView.ResizeToContents)  # Number column
        header.setSectionResizeMode(1, QHeaderView.Stretch)          # Text column
        header.setSectionResizeMode(2, QHeaderView.ResizeToContents)  # Number column

        # Set specific widths to ensure readability
        self.table.setColumnWidth(0, 60)   # Number column - narrower
        self.table.setColumnWidth(2, 80)   # Number column - narrower

        # Apply styling to match the application theme
        self.table.setStyleSheet("""
            QTableWidget {
                background-color: #16213e;
                color: #e0e0e0;
                gridline-color: #0f3460;
                border: 1px solid #0f3460;
                border-radius: 8px;
                font-size: 18px;  /* Reduced font size for better fit */
            }
            QTableWidget::item {
                padding: 8px 12px;
                border: 1px solid #0f3460;
            }
            QHeaderView::section {
                background-color: #0f3460;
                color: #e0e0e0;
                padding: 10px;
                border: 1px solid #16213e;
                font-weight: bold;
                font-size: 18px;  /* Reduced font size */
            }
        """)

        # Increase row height for better readability
        self.table.verticalHeader().setDefaultSectionSize(40)  # Taller rows for better readability

        layout.addWidget(self.table)

        # Set the default user (last selected user from setup screen)
        if self.default_user:
            self.user_combo.setCurrentText(self.default_user)
        elif self.user_combo.count() > 0:
            self.user_combo.setCurrentIndex(0)
        # Trigger initial table load
        self._on_user_changed(self.user_combo.currentText())

        # Action buttons
        btn_layout = QHBoxLayout()
        btn_layout.setAlignment(Qt.AlignCenter)
        
        self.add_btn = QPushButton("➕ Add Mapping")
        self.add_btn.setMinimumWidth(150)
        self.add_btn.clicked.connect(self._add_mapping)
        btn_layout.addWidget(self.add_btn)

        self.edit_btn = QPushButton("✏️ Edit Mapping")
        self.edit_btn.setMinimumWidth(150)
        self.edit_btn.clicked.connect(self._edit_mapping)
        btn_layout.addWidget(self.edit_btn)

        self.delete_btn = QPushButton("🗑️ Delete Mapping")
        self.delete_btn.setMinimumWidth(150)
        self.delete_btn.clicked.connect(self._delete_mapping)
        btn_layout.addWidget(self.delete_btn)

        layout.addLayout(btn_layout)

        # Home button
        home_btn = QPushButton("🏠 Home")
        home_btn.setMinimumWidth(200)
        home_btn.clicked.connect(self.go_home.emit)
        layout.addWidget(home_btn)

    def refresh_table(self):
        """Refresh the table with current user's custom mappings."""
        if not self.current_user:
            return
            
        # Clear the table
        self.table.setRowCount(0)
        
        # Load voice profiles and get current user's mappings
        from speech_engine import load_voice_profiles
        profiles = load_voice_profiles()
        user_mappings = profiles.get(self.current_user, {})
        
        # Add mappings to the table
        row = 0
        for text, number in user_mappings.items():
            self.table.insertRow(row)
            
            # Row number
            item = QTableWidgetItem(str(row + 1))
            item.setTextAlignment(Qt.AlignCenter)
            item.setFlags(item.flags() ^ Qt.ItemIsEditable)  # Make it non-editable
            item.setBackground(QColor("#0f3460"))  # Dark blue background like borders
            item.setForeground(QColor("#e0e0e0"))  # Light text color
            self.table.setItem(row, 0, item)
            
            # Spoken text
            item = QTableWidgetItem(text)
            item.setFlags(item.flags() ^ Qt.ItemIsEditable)  # Make it non-editable
            item.setBackground(QColor("#16213e"))  # Dark background like other UI elements
            item.setForeground(QColor("#e0e0e0"))  # Light text color
            self.table.setItem(row, 1, item)
            
            # Maps to number
            item = QTableWidgetItem(str(number))
            item.setTextAlignment(Qt.AlignCenter)
            item.setFlags(item.flags() ^ Qt.ItemIsEditable)  # Make it non-editable
            item.setBackground(QColor("#16213e"))  # Dark background like other UI elements
            item.setForeground(QColor("#e0e0e0"))  # Light text color
            self.table.setItem(row, 2, item)
            
            row += 1

    def _on_user_changed(self, user_name):
        """Called when the selected user changes."""
        self.current_user = user_name
        self.refresh_table()

    def _add_mapping(self):
        """Add a new custom mapping."""
        if not self.current_user:
            QMessageBox.warning(self, "No User Selected", "Please select a user first.")
            return

        dialog = CustomMappingDialog(self)
        if dialog.exec() == QDialog.Accepted:
            text, number = dialog.get_values()
            if text and number is not None:
                # Load existing profiles
                from speech_engine import load_voice_profiles, save_voice_profiles
                profiles = load_voice_profiles()
                
                # Ensure user exists in profiles
                if self.current_user not in profiles:
                    profiles[self.current_user] = {}
                    
                # Add the new mapping
                profiles[self.current_user][text] = number
                
                # Save profiles
                save_voice_profiles(profiles)
                
                # Update speech engine grammar for this user
                self.speech.set_user_grammar(self.current_user)
                
                # Refresh the table
                self.refresh_table()

    def _edit_mapping(self):
        """Edit an existing custom mapping."""
        if not self.current_user:
            QMessageBox.warning(self, "No User Selected", "Please select a user first.")
            return

        # Get selected row
        selected_rows = self.table.selectionModel().selectedRows()
        if not selected_rows:
            QMessageBox.information(self, "No Selection", "Please select a row to edit.")
            return

        row = selected_rows[0].row()
        
        # Get current values
        text_item = self.table.item(row, 1)
        number_item = self.table.item(row, 2)
        
        if not text_item or not number_item:
            return
            
        current_text = text_item.text()
        current_number = int(number_item.text())

        # Open dialog with current values
        dialog = CustomMappingDialog(self, current_text, current_number)
        if dialog.exec() == QDialog.Accepted:
            new_text, new_number = dialog.get_values()
            if new_text and new_number is not None:
                # Load existing profiles
                from speech_engine import load_voice_profiles, save_voice_profiles
                profiles = load_voice_profiles()
                
                # Ensure user exists in profiles
                if self.current_user not in profiles:
                    profiles[self.current_user] = {}
                
                # Remove old mapping
                if current_text in profiles[self.current_user]:
                    del profiles[self.current_user][current_text]
                
                # Add new mapping
                profiles[self.current_user][new_text] = new_number
                
                # Save profiles
                save_voice_profiles(profiles)
                
                # Update speech engine grammar for this user
                self.speech.set_user_grammar(self.current_user)
                
                # Refresh the table
                self.refresh_table()

    def _delete_mapping(self):
        """Delete an existing custom mapping."""
        if not self.current_user:
            QMessageBox.warning(self, "No User Selected", "Please select a user first.")
            return

        # Get selected row
        selected_rows = self.table.selectionModel().selectedRows()
        if not selected_rows:
            QMessageBox.information(self, "No Selection", "Please select a row to delete.")
            return

        row = selected_rows[0].row()
        
        # Get text to delete
        text_item = self.table.item(row, 1)
        if not text_item:
            return
            
        text_to_delete = text_item.text()
        
        # Confirm deletion
        reply = QMessageBox.question(self, "Confirm Deletion", 
                                   f"Are you sure you want to delete the mapping for '{text_to_delete}'?",
                                   QMessageBox.Yes | QMessageBox.No)
        if reply == QMessageBox.Yes:
            # Load existing profiles
            from speech_engine import load_voice_profiles, save_voice_profiles
            profiles = load_voice_profiles()
            
            # Remove the mapping
            if self.current_user in profiles and text_to_delete in profiles[self.current_user]:
                del profiles[self.current_user][text_to_delete]
                
                # Save profiles
                save_voice_profiles(profiles)
                
                # Update speech engine grammar for this user
                self.speech.set_user_grammar(self.current_user)
                
                # Refresh the table
                self.refresh_table()


class CustomMappingDialog(QDialog):
    """Dialog for adding/editing custom mappings."""
    
    def __init__(self, parent=None, text="", number=0):
        super().__init__(parent)
        self.setWindowTitle("Add/Edit Custom Mapping")
        self.setModal(True)
        self.resize(400, 150)
        
        layout = QVBoxLayout(self)
        
        # Input fields
        form_layout = QFormLayout()
        
        self.text_input = QLineEdit()
        self.text_input.setText(text)
        form_layout.addRow("Spoken Text:", self.text_input)
        
        self.number_input = QSpinBox()
        self.number_input.setRange(0, 200)
        self.number_input.setValue(number)
        form_layout.addRow("Maps To Number:", self.number_input)
        
        layout.addLayout(form_layout)
        
        # Buttons
        btn_layout = QHBoxLayout()
        btn_layout.addStretch()
        
        ok_btn = QPushButton("OK")
        ok_btn.clicked.connect(self.accept)
        btn_layout.addWidget(ok_btn)
        
        cancel_btn = QPushButton("Cancel")
        cancel_btn.clicked.connect(self.reject)
        btn_layout.addWidget(cancel_btn)
        
        layout.addLayout(btn_layout)
        
    def get_values(self):
        """Get the values entered by the user."""
        text = self.text_input.text().strip()
        number = self.number_input.value()
        
        if text:
            return text, number
        return None, None


# ════════════════════════════════════════════════════════════════════════
#  Main Window
# ════════════════════════════════════════════════════════════════════════

# ════════════════════════════════════════════════════════════════════════
#  User Management Screen
# ════════════════════════════════════════════════════════════════════════

class UserManagementScreen(QWidget):
    go_home = Signal()

    def __init__(self, db, speech):
        super().__init__()
        self.db = db
        self.speech = speech
        self._build_ui()

    def _build_ui(self):
        layout = QVBoxLayout(self)
        layout.setSpacing(16)
        layout.setContentsMargins(24, 16, 24, 16)

        # Title
        title = QLabel("👥  User Management")
        title.setFont(QFont("Segoe UI", 44, QFont.Bold))
        title.setStyleSheet("color: #53a8b6;")
        layout.addWidget(title)

        # Instructions
        instructions = QLabel("Add, delete, or manage user accounts and their learning history")
        instructions.setFont(QFont("Segoe UI", 22))
        instructions.setStyleSheet("color: #aaaacc;")
        instructions.setAlignment(Qt.AlignCenter)
        layout.addWidget(instructions)

        # User list
        self.user_list = QListWidget()
        self.user_list.setFont(QFont("Segoe UI", 22))
        self.user_list.setStyleSheet("""
            QListWidget {
                background-color: #16213e;
                color: #e0e0e0;
                border: 2px solid #0f3460;
                border-radius: 8px;
                padding: 12px;
                font-size: 26px;
            }
            QListWidget::item {
                padding: 8px;
                border-bottom: 1px solid #0f3460;
            }
            QListWidget::item:selected {
                background-color: #0f3460;
                color: #e0e0e0;
            }
        """)
        layout.addWidget(self.user_list)

        # Action buttons
        btn_layout = QHBoxLayout()
        btn_layout.setAlignment(Qt.AlignCenter)

        self.add_user_btn = QPushButton("➕ Add User")
        self.add_user_btn.setMinimumWidth(150)
        self.add_user_btn.clicked.connect(self._add_user)
        btn_layout.addWidget(self.add_user_btn)

        self.delete_user_btn = QPushButton("🗑️ Delete User")
        self.delete_user_btn.setMinimumWidth(150)
        self.delete_user_btn.clicked.connect(self._delete_user)
        btn_layout.addWidget(self.delete_user_btn)

        self.erase_history_btn = QPushButton("🧹 Erase History")
        self.erase_history_btn.setMinimumWidth(150)
        self.erase_history_btn.clicked.connect(self._erase_user_history)
        btn_layout.addWidget(self.erase_history_btn)

        layout.addLayout(btn_layout)

        # Home button
        home_btn = QPushButton("🏠 Home")
        home_btn.setMinimumWidth(200)
        home_btn.clicked.connect(self.go_home.emit)
        layout.addWidget(home_btn)

        # Refresh user list
        self._refresh_user_list()

    def _refresh_user_list(self):
        """Refresh the list of users."""
        self.user_list.clear()
        users = self.db.get_users()
        for user in users:
            self.user_list.addItem(user["name"])

    def _add_user(self):
        """Add a new user."""
        user_name, ok = QInputDialog.getText(self, "Add User", "Enter new user name:")
        if ok and user_name:
            user_name = user_name.strip()
            if not user_name:
                QMessageBox.warning(self, "Invalid Name", "User name cannot be empty.")
                return

            # Check if user already exists
            users = self.db.get_users()
            if any(user["name"] == user_name for user in users):
                QMessageBox.warning(self, "User Exists", f"User '{user_name}' already exists.")
                return

            # Add user to database
            self.db.add_user(user_name)
            
            # Also initialize voice profile for the new user
            from speech_engine import load_voice_profiles, save_voice_profiles
            profiles = load_voice_profiles()
            profiles[user_name] = {}
            save_voice_profiles(profiles)
            
            # Refresh the list
            self._refresh_user_list()
            QMessageBox.information(self, "Success", f"User '{user_name}' has been added.")

    def _delete_user(self):
        """Delete the selected user."""
        selected_items = self.user_list.selectedItems()
        if not selected_items:
            QMessageBox.information(self, "No Selection", "Please select a user to delete.")
            return

        user_name = selected_items[0].text()
        
        # Confirmation dialog
        reply = QMessageBox.question(
            self, 
            "Confirm Deletion", 
            f"Are you sure? This is PERMANENT!\n\nDeleting user '{user_name}' will remove:\n"
            "- All user data\n"
            "- All practice history\n"
            "- All spaced repetition state\n"
            "- All custom voice mappings\n\n"
            "This action cannot be undone.",
            QMessageBox.Yes | QMessageBox.No
        )
        
        if reply == QMessageBox.Yes:
            # Delete user from database
            user = self.db.get_user_by_name(user_name)
            if user:
                self.db.delete_user(user["id"])
                
                # Also remove from voice profiles
                from speech_engine import load_voice_profiles, save_voice_profiles
                profiles = load_voice_profiles()
                if user_name in profiles:
                    del profiles[user_name]
                save_voice_profiles(profiles)
                
                # Refresh the list
                self._refresh_user_list()
                QMessageBox.information(self, "Deleted", f"User '{user_name}' has been deleted.")

    def _erase_user_history(self):
        """Erase the selected user's history for the spaced repetition algorithm."""
        selected_items = self.user_list.selectedItems()
        if not selected_items:
            QMessageBox.information(self, "No Selection", "Please select a user to erase history for.")
            return

        user_name = selected_items[0].text()
        
        # Confirmation dialog
        reply = QMessageBox.question(
            self, 
            "Confirm History Erasure", 
            f"Are you sure? This is PERMANENT!\n\n"
            f"This will erase all spaced repetition history for '{user_name}'.\n"
            f"Their learning progress will be reset, but the user account will remain.\n\n"
            "This action cannot be undone.",
            QMessageBox.Yes | QMessageBox.No
        )
        
        if reply == QMessageBox.Yes:
            # Get user ID
            user = self.db.get_user_by_name(user_name)
            if user:
                user_id = user["id"]
                
                # Delete all fluency states for this user (spaced repetition data)
                self.db.delete_user_fluency_states(user_id)
                
                # Reset card states to default for this user
                # Since we don't have a specific method to reset all cards to default state,
                # we'll delete all existing states which will cause new sessions to use defaults
                QMessageBox.information(self, "History Erased", 
                                      f"Spaced repetition history for '{user_name}' has been erased.")


class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("Math Flashcards")
        # Set minimum size that accommodates all content without scrolling
        self.setMinimumSize(900, 700)
        # Resize to the custom size
        self.resize(1400, 1200)

        self.db = Database()
        self.speech = SpeechEngine()

        self.stack = QStackedWidget()
        self.setCentralWidget(self.stack)

        self.setup_screen = SetupScreen(self.db, self.speech)
        self.practice_screen = PracticeScreen(self.db, self.speech)
        self.results_screen = ResultsScreen(self.db)
        self.detail_screen = SessionDetailScreen(self.db)
        self.history_screen = HistoryScreen(self.db)
        
        # Initialize dictionary editor with the current user from setup screen
        initial_user = self.setup_screen.combo_user.currentText() if self.setup_screen.combo_user.count() > 0 else None
        self.dictionary_editor = CustomDictionaryEditor(self.db, self.speech, default_user=initial_user)
        self.user_management = UserManagementScreen(self.db, self.speech)

        self.stack.addWidget(self.setup_screen)      # 0
        self.stack.addWidget(self.practice_screen)    # 1
        self.stack.addWidget(self.results_screen)     # 2
        self.stack.addWidget(self.detail_screen)      # 3
        self.stack.addWidget(self.history_screen)     # 4
        self.stack.addWidget(self.dictionary_editor)  # 5
        self.stack.addWidget(self.user_management)    # 6

        self.setup_screen.start_session.connect(self._start_session)
        self.setup_screen.show_history.connect(self._show_history)
        self.setup_screen.show_dictionary.connect(self._show_dictionary)
        self.setup_screen.show_user_management.connect(self._show_user_management)
        self.practice_screen.session_ended.connect(self._show_results)
        self.results_screen.go_home.connect(self._go_home)
        self.results_screen.view_details.connect(self._show_detail)
        self.results_screen.start_retest.connect(self._start_retest)
        self.detail_screen.go_back.connect(self._back_from_detail)
        self.history_screen.go_home.connect(self._go_home)
        self.history_screen.view_session.connect(self._show_detail_from_history)
        self.history_screen.delete_session.connect(self._delete_session)
        self.dictionary_editor.go_home.connect(self._go_home)
        self.user_management.go_home.connect(self._go_home)

        self._last_results_session = None

    def _start_session(self, user_name, num_questions, op, selected_pairs):
        try:
            self.stack.setCurrentIndex(1)
            self.practice_screen.begin_session(user_name, num_questions, op, selected_pairs)
        except Exception as e:
            print(f"[ERROR] Session start failed: {e}")
            import traceback
            traceback.print_exc()
            QMessageBox.critical(self, "Error", f"Failed to start session:\n{e}")
            self.stack.setCurrentIndex(0)

    def _show_results(self, session_id):
        self._last_results_session = session_id
        self.results_screen.show_results(session_id)
        self.stack.setCurrentIndex(2)

    def _start_retest(self, session_id, count=10):
        """Start a retest session with the specified number of worst cards from a session."""
        try:
            sess = self.db.get_session(session_id)
            if not sess:
                return
            user_id = sess["user_id"]
            op = sess["op"] if "op" in sess.keys() else "add"
            user = self.db.get_users()
            user_name = None
            for u in user:
                if u["id"] == user_id:
                    user_name = u["name"]
                    break
            if not user_name:
                return

            # Get the worst card IDs stored by the results screen
            card_ids = self.results_screen._worst_card_ids[:count]
            if not card_ids:
                return

            # Look up (a, b) pairs for these card IDs
            cards = self.db.get_cards_by_ids(card_ids)
            selected_pairs = [(c["a"], c["b"]) for c in cards]

            # Ask user how many questions they want to do in the retest session
            from PySide6.QtWidgets import QInputDialog
            num_questions, ok = QInputDialog.getInt(
                self, "Number of Questions", 
                "How many questions would you like in this retest session?",
                50, 10, 500, 10  # Default: 50, Min: 10, Max: 500, Step: 10
            )
            if not ok:
                return  # User cancelled

            self.stack.setCurrentIndex(1)
            self.practice_screen.begin_session(
                user_name, num_questions, op, selected_pairs, is_retest=True
            )
        except Exception as e:
            print(f"[ERROR] Retest failed: {e}")
            import traceback
            traceback.print_exc()
            QMessageBox.critical(self, "Error", f"Failed to start retest:\n{e}")
            self.stack.setCurrentIndex(0)

    def _show_detail(self, session_id):
        self.detail_screen.show_session(session_id)
        self.stack.setCurrentIndex(3)
        self._detail_came_from = 2

    def _show_detail_from_history(self, session_id):
        self.detail_screen.show_session(session_id)
        self.stack.setCurrentIndex(3)
        self._detail_came_from = 4

    def _back_from_detail(self):
        self.stack.setCurrentIndex(getattr(self, "_detail_came_from", 0))

    def _delete_session(self, session_id):
        """Delete a session and recalculate the user's card states."""
        session = self.db.get_session(session_id)
        if not session:
            return
        
        user_id = session["user_id"]
        user = self.db.get_user_by_name(self.history_screen.combo_user.currentText())
        
        # Format session info for confirmation dialog
        session_date = ""
        if session["started_at"]:
            try:
                dt = datetime.fromisoformat(session["started_at"])
                session_date = dt.strftime("%Y-%m-%d %H:%M")
            except ValueError:
                session_date = session["started_at"][:16]
        
        op = session["op"] if "op" in session.keys() else "add"
        if op == "mul":
            op_label = "Multiplication"
        elif op == "sub":
            op_label = "Subtraction"
        else:
            op_label = "Addition"

        # Show confirmation dialog
        reply = QMessageBox.question(
            self,
            "Delete Session",
            f"Are you sure you want to delete this {op_label} session?\n\n"
            f"Date: {session_date}\n"
            f"This will remove all attempts from this session and recalculate "
            f"the spaced repetition algorithm based on remaining history.",
            QMessageBox.Yes | QMessageBox.No,
            QMessageBox.No
        )
        
        if reply == QMessageBox.Yes:
            try:
                # Delete the session
                self.db.delete_session(session_id)
                
                # Recalculate card states from remaining sessions
                self.db.recalculate_user_card_states(user_id)
                
                # Refresh the history display
                self.history_screen._refresh()
                
                # Show success message
                QMessageBox.information(
                    self,
                    "Session Deleted",
                    "Session deleted successfully.\n"
                    "Spaced repetition algorithm has been updated."
                )
            except Exception as e:
                QMessageBox.critical(
                    self,
                    "Error",
                    f"Failed to delete session:\n{e}"
                )

    def _show_history(self):
        user_name = self.setup_screen.combo_user.currentText()
        self.history_screen.refresh_for_user(user_name)
        self.stack.setCurrentIndex(4)

    def _show_dictionary(self):
        # Update the dictionary editor with the current user from setup screen
        current_user = self.setup_screen.combo_user.currentText()
        self.dictionary_editor.default_user = current_user
        self.dictionary_editor._on_user_changed(current_user)
        self.stack.setCurrentIndex(5)

    def _show_user_management(self):
        self.stack.setCurrentIndex(6)

    def _go_home(self):
        # Preserve the currently selected user
        current_user = self.setup_screen.combo_user.currentText()
        
        self.stack.setCurrentIndex(0)
        # Refresh the user dropdown to include any newly added users
        self.setup_screen.combo_user.clear()
        for u in self.db.get_users():
            self.setup_screen.combo_user.addItem(u["name"])
        # Restore the previously selected user
        if current_user:
            self.setup_screen.combo_user.setCurrentText(current_user)
        # Refresh the mastery score for the currently selected user
        self.setup_screen._refresh_mastery_score()
        # Ensure the correct operation tab is active
        self.setup_screen._set_op(self.setup_screen.current_op)

    def closeEvent(self, event):
        self.speech.stop_listening()
        self.db.close()
        super().closeEvent(event)


# ════════════════════════════════════════════════════════════════════════
#  Entry point
# ════════════════════════════════════════════════════════════════════════

def main():
    app = QApplication(sys.argv)
    app.setStyleSheet(STYLE_SHEET)
    window = MainWindow()
    window.show()
    sys.exit(app.exec())


if __name__ == "__main__":
    main()
