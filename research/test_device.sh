#!/bin/bash
# Run Tapo device test script
# Activates Python virtual environment and runs the test

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV_DIR="$SCRIPT_DIR/venv"

# Check if venv exists
if [ ! -d "$VENV_DIR" ]; then
    echo "❌ Virtual environment not found at: $VENV_DIR"
    echo ""
    echo "To create it, run:"
    echo "  cd research"
    echo "  python3 -m venv venv"
    echo "  source venv/bin/activate"
    echo "  pip install pytapo"
    exit 1
fi

# Activate venv and run test
echo "🔧 Activating virtual environment..."
source "$VENV_DIR/bin/activate"

echo "🚀 Running Tapo device test..."
echo ""

python3 "$SCRIPT_DIR/test_control.py"

EXIT_CODE=$?

deactivate

if [ $EXIT_CODE -eq 0 ]; then
    echo ""
    echo "✅ Test completed successfully!"
else
    echo ""
    echo "❌ Test failed with exit code $EXIT_CODE"
fi

exit $EXIT_CODE
