#!/bin/bash
echo "📦 Migrating existing code..."

# Copy Sidekick AI code
if [ -d "/d/projects/sidekick-ai/sidekick-ai" ]; then
    echo "Copying Sidekick AI source..."
    mkdir -p extension/src
    cp -r /d/projects/sidekick-ai/sidekick-ai/src/* extension/src/ 2>/dev/null || true
    cp /d/projects/sidekick-ai/sidekick-ai/package.json extension/package.sidekick.json 2>/dev/null || true
    cp /d/projects/sidekick-ai/sidekick-ai/tsconfig.json extension/tsconfig.sidekick.json 2>/dev/null || true
    echo "✅ Sidekick AI code found and copied"
else
    echo "⚠️  Sidekick AI not found at ../../sidekick-ai"
fi

# Copy Context Keeper code  
if [ -d "/d/projects/context-keeper" ]; then
    echo "Copying Context Keeper source..."
    cp -r /d/projects/context-keeper/backend/* backend/ 2>/dev/null || true
    # Also copy the frontend if it exists
    if [ -d "/d/projects/context-keeper/frontend" ]; then
        mkdir -p frontend
        cp -r /d/projects/context-keeper/frontend/* frontend/ 2>/dev/null || true
        echo "✅ Context Keeper frontend copied"
    fi
    echo "✅ Context Keeper backend found and copied"
else
    echo "⚠️  Context Keeper not found"
fi

echo "📝 Migration complete!"
echo ""
echo "Checking what was copied..."
echo "Extension source files:"
ls -la extension/src/ 2>/dev/null || echo "  No files found"
echo ""
echo "Backend files:"
ls -la backend/ 2>/dev/null || echo "  No files found"