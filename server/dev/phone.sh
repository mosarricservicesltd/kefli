#!/bin/sh
# Points the phone's localhost ports at this machine over USB, for the local stack.
ADB="${ADB:-$HOME/Android/Sdk/platform-tools/adb}"
for p in 7447 7448 7449 3447 3448 8447; do "$ADB" reverse tcp:$p tcp:$p; done
"$ADB" reverse --list
