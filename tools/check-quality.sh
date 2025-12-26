#!/bin/bash

# Code Quality Check Script for Zero
# Run before deployments to ensure code quality standards

set -e

YELLOW='\033[1;33m'
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
BOLD='\033[1m'
NC='\033[0m' # No Color

echo -e "${BOLD}${BLUE}🔍 Code Quality Check${NC}\n"

ERROR_COUNT=0
WARNING_COUNT=0

# 1. TypeScript compilation check
echo -e "${BLUE}Checking TypeScript compilation...${NC}"
if npx tsc --noEmit 2>&1 | grep -q "error"; then
    echo -e "${RED}✗ TypeScript compilation failed${NC}"
    npx tsc --noEmit || true
    ((ERROR_COUNT++))
else
    echo -e "${GREEN}✓ TypeScript compilation successful${NC}\n"
fi

# 2. Check for dangerous type assertions
echo -e "${BLUE}Checking for type assertions...${NC}"

# Check for "any" usage (excluding test files)
ANY_COUNT=$(grep -r "as any\|: any\|<any>" src --include="*.ts" --include="*.tsx" --exclude-dir=__tests__ --exclude="*.test.ts" --exclude="*.spec.ts" 2>/dev/null | wc -l || echo 0)
if [ "$ANY_COUNT" -gt 0 ]; then
    echo -e "${YELLOW}⚠ Found $ANY_COUNT uses of 'any'${NC}"
    grep -r "as any\|: any" src --include="*.ts" --include="*.tsx" --exclude-dir=__tests__ --exclude="*.test.ts" --exclude="*.spec.ts" | head -5 || true
    ((WARNING_COUNT+=$ANY_COUNT))
else
    echo -e "${GREEN}✓ No 'any' usage found${NC}"
fi

# Check for "unknown" casts (excluding test files)
UNKNOWN_COUNT=$(grep -r "as unknown" src --include="*.ts" --include="*.tsx" --exclude-dir=__tests__ --exclude="*.test.ts" --exclude="*.spec.ts" 2>/dev/null | wc -l || echo 0)
if [ "$UNKNOWN_COUNT" -gt 0 ]; then
    echo -e "${YELLOW}⚠ Found $UNKNOWN_COUNT uses of 'as unknown'${NC}"
    grep -r "as unknown" src --include="*.ts" --include="*.tsx" --exclude-dir=__tests__ --exclude="*.test.ts" --exclude="*.spec.ts" | head -5 || true
    ((WARNING_COUNT+=$UNKNOWN_COUNT))
else
    echo -e "${GREEN}✓ No 'unknown' casts found${NC}"
fi

# Check for type assertion chains (excluding test files)
ASSERTION_CHAIN_COUNT=$(grep -r "as .* as" src --include="*.ts" --include="*.tsx" --exclude-dir=__tests__ --exclude="*.test.ts" --exclude="*.spec.ts" 2>/dev/null | wc -l || echo 0)
if [ "$ASSERTION_CHAIN_COUNT" -gt 0 ]; then
    echo -e "${RED}✗ Found $ASSERTION_CHAIN_COUNT type assertion chains (as X as Y)${NC}"
    grep -r "as .* as" src --include="*.ts" --include="*.tsx" --exclude-dir=__tests__ --exclude="*.test.ts" --exclude="*.spec.ts" | head -5 || true
    ((ERROR_COUNT+=$ASSERTION_CHAIN_COUNT))
else
    echo -e "${GREEN}✓ No type assertion chains${NC}"
fi

echo ""

# 3. Check for @ts-ignore and @ts-nocheck
echo -e "${BLUE}Checking for TypeScript suppressions...${NC}"
TS_IGNORE_COUNT=$(grep -r "@ts-ignore\|@ts-nocheck" src --include="*.ts" --include="*.tsx" 2>/dev/null | wc -l || echo 0)
if [ "$TS_IGNORE_COUNT" -gt 0 ]; then
    echo -e "${RED}✗ Found $TS_IGNORE_COUNT TypeScript suppressions${NC}"
    grep -r "@ts-ignore\|@ts-nocheck" src --include="*.ts" --include="*.tsx" | head -5 || true
    ((ERROR_COUNT+=$TS_IGNORE_COUNT))
else
    echo -e "${GREEN}✓ No TypeScript suppressions${NC}"
fi

echo ""

# 4. Check JSON validity
echo -e "${BLUE}Checking JSON files...${NC}"
JSON_ERROR=0
for file in $(find src -name "*.json" -type f 2>/dev/null); do
    if ! python3 -m json.tool "$file" > /dev/null 2>&1; then
        echo -e "${RED}✗ Invalid JSON: $file${NC}"
        ((JSON_ERROR++))
    fi
done

if [ "$JSON_ERROR" -eq 0 ]; then
    echo -e "${GREEN}✓ All JSON files are valid${NC}"
else
    echo -e "${RED}✗ Found $JSON_ERROR invalid JSON files${NC}"
    ((ERROR_COUNT+=$JSON_ERROR))
fi

echo ""

# 5. Check for console statements
echo -e "${BLUE}Checking for console statements...${NC}"
CONSOLE_COUNT=$(grep -r "console\.\(log\|debug\|info\|warn\|error\)" src --include="*.ts" --include="*.tsx" --exclude-dir=__tests__ 2>/dev/null | wc -l || echo 0)
if [ "$CONSOLE_COUNT" -gt 0 ]; then
    echo -e "${YELLOW}⚠ Found $CONSOLE_COUNT console statements${NC}"
    grep -r "console\." src --include="*.ts" --include="*.tsx" | head -5 || true
    ((WARNING_COUNT+=$CONSOLE_COUNT))
else
    echo -e "${GREEN}✓ No console statements${NC}"
fi

echo ""

# 6. Check for TODO/FIXME/HACK comments
echo -e "${BLUE}Checking for TODO/FIXME/HACK comments...${NC}"
TODO_COUNT=$(grep -r "TODO\|FIXME\|HACK\|XXX" src --include="*.ts" --include="*.tsx" 2>/dev/null | wc -l || echo 0)
if [ "$TODO_COUNT" -gt 0 ]; then
    echo -e "${YELLOW}ℹ Found $TODO_COUNT TODO/FIXME/HACK comments${NC}"
    grep -r "TODO\|FIXME" src --include="*.ts" --include="*.tsx" | head -3 || true
fi

echo ""

# 7. Check for debug window properties (double-underscore)
echo -e "${BLUE}Checking for debug window properties...${NC}"
DEBUG_PROPS=$(grep -r "window\.__\|window as any)\.__" src --include="*.ts" --include="*.tsx" 2>/dev/null | wc -l || echo 0)
if [ "$DEBUG_PROPS" -gt 0 ]; then
    echo -e "${YELLOW}⚠ Found $DEBUG_PROPS debug window properties (window.__*)${NC}"
    grep -r "window\.__\|window as any)\.__" src --include="*.ts" --include="*.tsx" | head -3 || true
    ((WARNING_COUNT+=$DEBUG_PROPS))
else
    echo -e "${GREEN}✓ No debug window properties${NC}"
fi

echo ""

# 8. Check for debugger statements
echo -e "${BLUE}Checking for debugger statements...${NC}"
DEBUGGER_COUNT=$(grep -r "debugger;" src --include="*.ts" --include="*.tsx" 2>/dev/null | wc -l || echo 0)
if [ "$DEBUGGER_COUNT" -gt 0 ]; then
    echo -e "${RED}✗ Found $DEBUGGER_COUNT debugger statements${NC}"
    grep -r "debugger;" src --include="*.ts" --include="*.tsx" || true
    ((ERROR_COUNT+=$DEBUGGER_COUNT))
else
    echo -e "${GREEN}✓ No debugger statements${NC}"
fi

echo ""

# 9. Check for hardcoded localhost URLs
echo -e "${BLUE}Checking for hardcoded localhost URLs...${NC}"
LOCALHOST_COUNT=$(grep -r "localhost:[0-9]" src --include="*.ts" --include="*.tsx" 2>/dev/null | wc -l || echo 0)
if [ "$LOCALHOST_COUNT" -gt 0 ]; then
    echo -e "${YELLOW}⚠ Found $LOCALHOST_COUNT hardcoded localhost URLs${NC}"
    grep -r "localhost:[0-9]" src --include="*.ts" --include="*.tsx" | head -3 || true
    ((WARNING_COUNT+=$LOCALHOST_COUNT))
else
    echo -e "${GREEN}✓ No hardcoded localhost URLs${NC}"
fi

echo ""

# Summary
echo -e "${BOLD}${BLUE}═══ Quality Check Summary ═══${NC}\n"
echo -e "  ${RED}Errors:   $ERROR_COUNT${NC}"
echo -e "  ${YELLOW}Warnings: $WARNING_COUNT${NC}"

if [ "$ERROR_COUNT" -eq 0 ] && [ "$WARNING_COUNT" -eq 0 ]; then
    echo -e "\n${GREEN}${BOLD}✓ Code quality check passed!${NC}"
    exit 0
elif [ "$ERROR_COUNT" -eq 0 ]; then
    echo -e "\n${YELLOW}${BOLD}⚠ Code quality check passed with warnings${NC}"
    exit 0
else
    echo -e "\n${RED}${BOLD}✗ Code quality check failed${NC}"
    exit 1
fi
