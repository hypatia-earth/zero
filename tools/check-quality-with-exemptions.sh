#!/bin/bash

# Code Quality Check Script with Exemption Support for Zero
#
# Supports inline exemptions with comments:
#   // quality-check-disable-next-line any-usage
#   // quality-check-disable-next-line: Reason why this is needed
#   /* quality-check-exempt: any - DOM types require any here */

set -e

YELLOW='\033[1;33m'
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
BOLD='\033[1m'
NC='\033[0m' # No Color

echo -e "${BOLD}${BLUE}🔍 Code Quality Check with Exemptions${NC}\n"

ERROR_COUNT=0
WARNING_COUNT=0
EXEMPTED_COUNT=0

# Function to check if a line has an exemption comment
has_exemption() {
    local file=$1
    local line_num=$2
    local check_type=$3

    # Check the line before for exemption comment
    if [ "$line_num" -gt 1 ]; then
        local prev_line=$(sed -n "$((line_num-1))p" "$file")
        if echo "$prev_line" | grep -qE "quality-check-disable|quality-check-exempt|@quality-exempt|QC-OK|SAFE:"; then
            return 0
        fi
    fi

    # Check same line for trailing exemption
    local current_line=$(sed -n "${line_num}p" "$file")
    if echo "$current_line" | grep -qE "// QC-OK|// SAFE:|// quality-check-exempt"; then
        return 0
    fi

    return 1
}

# 1. TypeScript compilation check
echo -e "${BLUE}Checking TypeScript compilation...${NC}"
if npx tsc --noEmit 2>&1 | grep -q "error"; then
    echo -e "${RED}✗ TypeScript compilation failed${NC}"
    npx tsc --noEmit || true
    ((ERROR_COUNT++))
else
    echo -e "${GREEN}✓ TypeScript compilation successful${NC}\n"
fi

# 2. Check for "any" usage with exemptions
echo -e "${BLUE}Checking for 'any' usage...${NC}"

UNEXEMPTED_ANY=0
EXEMPTED_ANY=0

# Find all TypeScript files
for file in $(find src -name "*.ts" -o -name "*.tsx" | grep -v __tests__ | grep -v ".test.ts" | grep -v ".spec.ts"); do
    # Get line numbers with "any"
    grep -n "as any\|: any\|<any>" "$file" 2>/dev/null | while IFS=: read -r line_num content; do
        if has_exemption "$file" "$line_num" "any"; then
            ((EXEMPTED_ANY++))
        else
            if [ $UNEXEMPTED_ANY -lt 5 ]; then
                echo -e "${YELLOW}  $file:$line_num${NC}"
                echo "    $(echo "$content" | sed 's/^[[:space:]]*//' | cut -c 1-80)"
            fi
            ((UNEXEMPTED_ANY++))
        fi
    done || true
done

if [ "$UNEXEMPTED_ANY" -eq 0 ]; then
    echo -e "${GREEN}✓ No undocumented 'any' usage${NC}"
    if [ "$EXEMPTED_ANY" -gt 0 ]; then
        echo -e "${BLUE}  ($EXEMPTED_ANY documented exemptions)${NC}"
    fi
else
    echo -e "${YELLOW}⚠ Found $UNEXEMPTED_ANY undocumented uses of 'any'${NC}"
    if [ "$EXEMPTED_ANY" -gt 0 ]; then
        echo -e "${BLUE}  ($EXEMPTED_ANY documented exemptions)${NC}"
    fi
    ((WARNING_COUNT+=$UNEXEMPTED_ANY))
fi

echo ""

# 3. Check for @ts-ignore with documentation
echo -e "${BLUE}Checking for TypeScript suppressions...${NC}"

UNDOCUMENTED_SUPPRESS=0
DOCUMENTED_SUPPRESS=0

for file in $(find src -name "*.ts" -o -name "*.tsx"); do
    grep -n "@ts-ignore\|@ts-nocheck" "$file" 2>/dev/null | while IFS=: read -r line_num content; do
        # Check if there's a reason on the same line
        if echo "$content" | grep -qE "@ts-ignore.*-|@ts-ignore.*:|@ts-nocheck.*-|@ts-nocheck.*:"; then
            ((DOCUMENTED_SUPPRESS++))
        else
            if [ $UNDOCUMENTED_SUPPRESS -lt 3 ]; then
                echo -e "${RED}  $file:$line_num - No reason provided${NC}"
                echo "    $(echo "$content" | sed 's/^[[:space:]]*//' | cut -c 1-80)"
            fi
            ((UNDOCUMENTED_SUPPRESS++))
        fi
    done || true
done

if [ "$UNDOCUMENTED_SUPPRESS" -eq 0 ]; then
    echo -e "${GREEN}✓ All TypeScript suppressions documented${NC}"
    if [ "$DOCUMENTED_SUPPRESS" -gt 0 ]; then
        echo -e "${BLUE}  ($DOCUMENTED_SUPPRESS documented suppressions)${NC}"
    fi
else
    echo -e "${RED}✗ Found $UNDOCUMENTED_SUPPRESS undocumented TypeScript suppressions${NC}"
    echo -e "${BLUE}  Use format: @ts-ignore - Reason why this is needed${NC}"
    ((ERROR_COUNT+=$UNDOCUMENTED_SUPPRESS))
fi

echo ""

# 4. Report on exemption patterns
echo -e "${BLUE}Checking exemption documentation quality...${NC}"

# Find all exemption comments
GOOD_EXEMPTIONS=$(grep -r "quality-check-.*:.*\|QC-OK:.*\|SAFE:.*" src --include="*.ts" --include="*.tsx" 2>/dev/null | wc -l || echo 0)
BAD_EXEMPTIONS=$(grep -r "quality-check-disable-next-line$\|QC-OK$\|SAFE$" src --include="*.ts" --include="*.tsx" 2>/dev/null | wc -l || echo 0)

if [ "$BAD_EXEMPTIONS" -gt 0 ]; then
    echo -e "${YELLOW}⚠ Found $BAD_EXEMPTIONS exemptions without explanations${NC}"
    echo -e "  ${BLUE}Use format: // QC-OK: Reason why this is acceptable${NC}"
    grep -r "quality-check-disable-next-line$\|QC-OK$\|SAFE$" src --include="*.ts" --include="*.tsx" 2>/dev/null | head -3 || true
else
    echo -e "${GREEN}✓ All exemptions have explanations${NC}"
fi

if [ "$GOOD_EXEMPTIONS" -gt 0 ]; then
    echo -e "${GREEN}  Found $GOOD_EXEMPTIONS properly documented exemptions${NC}"
fi

echo ""

# Summary
echo -e "${BOLD}${BLUE}═══ Quality Check Summary ═══${NC}\n"
echo -e "  ${RED}Errors:   $ERROR_COUNT${NC}"
echo -e "  ${YELLOW}Warnings: $WARNING_COUNT${NC}"
echo -e "  ${GREEN}Exempted: $((EXEMPTED_ANY + DOCUMENTED_SUPPRESS + GOOD_EXEMPTIONS))${NC}"

echo -e "\n${BOLD}Exemption Formats:${NC}"
echo -e "  ${BLUE}// QC-OK: Reason${NC} - Mark line as acceptable"
echo -e "  ${BLUE}// SAFE: Explanation${NC} - Alternative format"
echo -e "  ${BLUE}// @ts-ignore - Reason${NC} - Document TS suppressions"
echo -e "  ${BLUE}/* quality-check-exempt: any - Reason */${NC} - Block comment"

if [ "$ERROR_COUNT" -eq 0 ] && [ "$WARNING_COUNT" -le 50 ]; then
    echo -e "\n${GREEN}${BOLD}✓ Code quality check passed!${NC}"
    exit 0
elif [ "$ERROR_COUNT" -eq 0 ]; then
    echo -e "\n${YELLOW}${BOLD}⚠ Code quality check passed with warnings${NC}"
    exit 0
else
    echo -e "\n${RED}${BOLD}✗ Code quality check failed${NC}"
    exit 1
fi
