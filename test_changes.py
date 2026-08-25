#!/usr/bin/env python3
"""Test script to verify the changes made to the Math Flashcards app."""

import os
import json
from speech_engine import parse_number

def test_remembered_answers_structure():
    """Test that the remembered answers structure works as expected."""
    
    # Simulate the remembered answers structure
    # Format: {(a, b, user_answer): correct_answer}
    remembered_answers = {}
    
    # Test case: user says "idiot" when the answer should be 88
    # This means when user says "idiot" for problem (8, 9) -> 8+9=17, or any problem that equals 88
    # Actually, let's say for problem 8*11=88, user says "idiot" and we remember that
    
    # Add a test case
    remembered_answers[(8, 11, 999)] = 88  # User says 999 but means 88 for 8*11
    
    # Test if the lookup works
    test_key = (8, 11, 999)
    if test_key in remembered_answers:
        correct_answer = remembered_answers[test_key]
        print(f"✓ Remembered answer lookup works: {test_key} -> {correct_answer}")
    else:
        print("✗ Remembered answer lookup failed")
    
    # Test JSON serialization/deserialization
    try:
        # Convert to JSON-serializable format
        json_data = {f"{k[0]},{k[1]},{k[2]}": v for k, v in remembered_answers.items()}
        print(f"✓ Serialization works: {json_data}")
        
        # Convert back
        restored_data = {(int(k.split(',')[0]), int(k.split(',')[1]), int(k.split(',')[2])): v 
                        for k, v in json_data.items()}
        print(f"✓ Deserialization works: {restored_data}")
        
        if remembered_answers == restored_data:
            print("✓ Round-trip serialization/deserialization successful")
        else:
            print("✗ Round-trip serialization/deserialization failed")
    except Exception as e:
        print(f"✗ Serialization/deserialization error: {e}")

def test_parse_number_with_custom_map():
    """Test that parse_number works with custom mappings."""
    # Test with a custom map that maps "idiot" to 88
    custom_map = {"idiot": 88, "banana": 5}
    
    # Test normal parsing
    result1 = parse_number("88", custom_map)
    print(f"parse_number('88', custom_map) = {result1}")
    
    # Test custom mapping
    result2 = parse_number("idiot", custom_map)
    print(f"parse_number('idiot', custom_map) = {result2}")
    
    # Test another custom mapping
    result3 = parse_number("banana", custom_map)
    print(f"parse_number('banana', custom_map) = {result3}")
    
    if result1 == 88 and result2 == 88 and result3 == 5:
        print("✓ Custom mapping in parse_number works correctly")
    else:
        print("✗ Custom mapping in parse_number failed")

def test_sound_generation():
    """Test that the sound generation function can be called without errors."""
    try:
        import winsound
        # This would normally play a sound, but we're just testing it doesn't crash
        winsound.Beep(1047, 300)  # C6 note for 300ms
        print("✓ Sound generation works")
    except Exception as e:
        print(f"Note: Sound generation test failed (might be expected on some systems): {e}")

if __name__ == "__main__":
    print("Testing the changes made to Math Flashcards app...")
    print()
    
    print("1. Testing remembered answers structure:")
    test_remembered_answers_structure()
    print()
    
    print("2. Testing custom number parsing:")
    test_parse_number_with_custom_map()
    print()
    
    print("3. Testing sound generation:")
    test_sound_generation()
    print()
    
    print("All tests completed!")