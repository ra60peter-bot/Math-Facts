"""Debug script to check mastery score calculation."""

from database import Database

# Connect to the database
db = Database()

# Get all users
users = db.get_users()
print("Users in database:")
for user in users:
    print(f"  ID: {user['id']}, Name: {user['name']}")

# Find the user with name containing "dat"
target_user = None
for user in users:
    if "dat" in user['name'].lower():
        target_user = user
        break

if target_user:
    print(f"\nFound user: {target_user['name']} (ID: {target_user['id']})")
    
    # Calculate mastery scores for both operations
    print("\nCalculating mastery scores...")
    
    # For addition
    add_score, add_total, add_mastered, add_attempted = db.compute_mastery_score(target_user['id'], "add")
    print(f"Addition: {add_score}/1000, {add_mastered} of {add_total} facts mastered, {add_attempted} attempted")
    
    # For multiplication
    mul_score, mul_total, mul_mastered, mul_attempted = db.compute_mastery_score(target_user['id'], "mul")
    print(f"Multiplication: {mul_score}/1000, {mul_mastered} of {mul_total} facts mastered, {mul_attempted} attempted")
    
    # Let's also check some of the user's card states
    print("\nChecking some user card states...")
    states = db.get_all_user_card_states(target_user['id'])
    print(f"Number of card states for user: {len(states)}")
    
    # Count by state
    state_counts = {}
    for state in states:
        s = state['state']
        state_counts[s] = state_counts.get(s, 0) + 1
        
    print(f"State distribution: {state_counts}")
    
    # Show some examples of mastered cards
    mastered_cards = [s for s in states if s['state'] == 'mastered']
    print(f"Number of mastered cards: {len(mastered_cards)}")
    if mastered_cards:
        print("First few mastered cards (with rolling_avg_ms):")
        for i, card in enumerate(mastered_cards[:5]):
            avg_ms = card['rolling_avg_ms'] or 0
            print(f"  Card {i+1}: rolling_avg={avg_ms}ms, consecutive_fast={card['consecutive_fast']}")
else:
    print("\nCould not find a user with 'dat' in the name")