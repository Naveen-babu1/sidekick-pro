#!/bin/bash
echo "Starting Sidekick Pro..."

# Start backend
cd backend
source venv/Scripts/activate
python app/main.py &
BACKEND_PID=$!

cd ..
echo "Backend running (PID: $BACKEND_PID)"
echo "Open VS Code in this directory and press F5"
echo "Press Ctrl+C to stop"

trap "kill $BACKEND_PID" INT
wait
