#!/bin/bash

echo "🚀 Starting Sidekick Pro..."
echo ""

# Start Context Keeper backend
echo "Starting Context Keeper backend..."
cd backend
source venv/Scripts/activate
python app/main.py &
BACKEND_PID=$!

echo "Backend started with PID: $BACKEND_PID"
echo ""

# Wait for backend
sleep 5

echo "✅ Sidekick Pro is ready!"
echo "   Backend: http://localhost:8000"
echo "   Health: http://localhost:8000/health"
echo ""
echo "Press Ctrl+C to stop..."

# Wait for Ctrl+C
trap "echo 'Stopping...'; kill $BACKEND_PID; exit" INT
wait $BACKEND_PID
