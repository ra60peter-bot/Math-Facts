#!/usr/bin/env python3
"""Create a new user called TEST in the database."""

from database import Database

def main():
    db = Database()
    
    # Check if user already exists
    existing = db.get_user_by_name("TEST")
    if existing:
        print(f"User 'TEST' already exists with ID {existing['id']}")
    else:
        # Insert the new user
        cursor = db.conn.cursor()
        cursor.execute(
            "INSERT INTO users(name) VALUES(?)",
            ("TEST",)
        )
        db.conn.commit()
        print(f"User 'TEST' created successfully with ID {cursor.lastrowid}")
    
    db.close()

if __name__ == "__main__":
    main()
