#!/bin/bash

# Local CI Script - Run all checks before pushing
# This mirrors the GitHub Actions workflows to catch issues early

set -e  # Exit on any error

# Get repo root (parent of scripts/ directory)
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Track results
CHECKS_PASSED=0
CHECKS_FAILED=0

print_header() {
    echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${BLUE}  🚀 Running Local CI Checks${NC}"
    echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo ""
}

print_summary() {
    echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${BLUE}  📊 Summary${NC}"
    echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo ""
    echo -e "  ${GREEN}Passed: $CHECKS_PASSED${NC}"
    echo -e "  ${RED}Failed: $CHECKS_FAILED${NC}"
    echo ""

    if [ $CHECKS_FAILED -eq 0 ]; then
        echo -e "${GREEN}✓ All checks passed! Ready to push.${NC}"
        echo ""
        exit 0
    else
        echo -e "${RED}✗ Some checks failed. Fix issues before pushing.${NC}"
        echo ""
        exit 1
    fi
}

print_header

# ===========================================================================
# CHECK: pnpm installed
# ===========================================================================

if ! command -v pnpm &> /dev/null; then
    echo -e "${RED}✗ pnpm not found${NC}"
    echo "  Install with: npm install -g pnpm"
    exit 1
fi

# ===========================================================================
# CHECK: Install dependencies
# ===========================================================================

echo -e "${YELLOW}→ Installing dependencies...${NC}"
pnpm install --frozen-lockfile > /dev/null || {
    echo -e "${RED}✗ Dependencies install failed${NC}"
    ((CHECKS_FAILED++))
    print_summary
}
echo -e "${GREEN}✓ Dependencies installed${NC}"
((CHECKS_PASSED++))

# ===========================================================================
# CHECK: Linting
# ===========================================================================

echo -e "${YELLOW}→ Running linter...${NC}"
if pnpm run lint > /dev/null 2>&1; then
    echo -e "${GREEN}✓ Linter passed${NC}"
    ((CHECKS_PASSED++))
else
    echo -e "${RED}✗ Linter failed${NC}"
    echo ""
    pnpm run lint  # Show the errors
    ((CHECKS_FAILED++))
    print_summary
fi

# ===========================================================================
# CHECK: TypeScript type check
# ===========================================================================

echo -e "${YELLOW}→ Running TypeScript type check...${NC}"
if pnpm exec tsc --noEmit > /dev/null 2>&1; then
    echo -e "${GREEN}✓ Type check passed${NC}"
    ((CHECKS_PASSED++))
else
    echo -e "${RED}✗ Type check failed${NC}"
    echo ""
    pnpm exec tsc --noEmit  # Show the errors
    ((CHECKS_FAILED++))
    print_summary
fi

# ===========================================================================
# CHECK: Build
# ===========================================================================

echo -e "${YELLOW}→ Building project...${NC}"
if pnpm run build > /dev/null 2>&1; then
    # Verify artifacts
    if [ -f "dist/index.js" ] && [ -f "dist/index.d.ts" ]; then
        echo -e "${GREEN}✓ Build succeeded${NC}"
        ((CHECKS_PASSED++))
    else
        echo -e "${RED}✗ Build artifacts missing${NC}"
        ((CHECKS_FAILED++))
        print_summary
    fi
else
    echo -e "${RED}✗ Build failed${NC}"
    echo ""
    pnpm run build  # Show the errors
    ((CHECKS_FAILED++))
    print_summary
fi

# ===========================================================================
# SUMMARY
# ===========================================================================

print_summary
