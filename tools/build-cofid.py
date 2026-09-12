#!/usr/bin/env python3
"""
Turn McCance & Widdowson's Composition of Foods Integrated Dataset (CoFID 2021)
into foods-uk.js for Tally.

  python3 tools/build-cofid.py path/to/CoFID.xlsx > foods-uk.js

Source: Public Health England, published on gov.uk under the Open Government
Licence v3.0. https://www.gov.uk/government/publications/composition-of-foods-integrated-dataset-cofid

CoFID marks values as:
  a number  — measured
  "Tr"      — trace, treated here as 0
  "N"       — not measured, treated here as unknown (omitted)
  "(12)"    — estimated; the parentheses are dropped and the value kept
Blank cells are unknown.

Foods with no energy value are dropped: a calorie diary entry without calories
is worse than no entry at all.
"""
import json
import re
import sys
import openpyxl

# CoFID group letters -> the category shown in the app
GROUPS = {
    "A": "Cereals",
    "B": "Dairy",
    "C": "Eggs",
    "D": "Vegetables",
    "F": "Fruit",
    "G": "Nuts & seeds",
    "H": "Herbs & spices",
    "J": "Fish",
    "M": "Meat",
    "O": "Fats & oils",
    "P": "Drinks",
    "Q": "Alcohol",
    "S": "Snacks & sugars",
    "W": "Soups & sauces",
}

# column indexes in "1.3 Proximates"
C_CODE, C_NAME, C_GROUP = 0, 1, 3
C_PROT, C_FAT, C_CHO, C_KCAL = 9, 10, 11, 12
C_SUGAR, C_NSP, C_AOAC = 16, 24, 25
# column index in "1.4 Inorganics"
C_SODIUM = 7

stats = {"rows": 0, "kept": 0, "no_energy": 0, "odd": 0}


def val(cell):
    """CoFID cell -> float or None."""
    if cell is None:
        return None
    if isinstance(cell, (int, float)):
        return float(cell)
    s = str(cell).strip()
    if s == "" or s.upper() == "N":
        return None
    if s.lower().startswith("tr"):
        return 0.0
    s = s.strip("()")                      # estimated values
    s = re.sub(r"^[<>~=]+", "", s).strip()  # occasional modifiers
    try:
        return float(s)
    except ValueError:
        stats["odd"] += 1
        return None


def r(v, places):
    if v is None:
        return None
    v = round(v, places)
    return int(v) if places == 0 else v


def main(path):
    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)

    # sodium lives on a different sheet, keyed by food code
    sodium = {}
    for row in wb["1.4 Inorganics"].iter_rows(min_row=4, values_only=True):
        code = row[C_CODE]
        if code:
            sodium[str(code).strip()] = val(row[C_SODIUM])

    out = []
    for row in wb["1.3 Proximates"].iter_rows(min_row=4, values_only=True):
        code = row[C_CODE]
        if not code:
            continue
        stats["rows"] += 1

        kcal = val(row[C_KCAL])
        if kcal is None:
            stats["no_energy"] += 1
            continue

        name = str(row[C_NAME] or "").strip()
        if not name:
            continue
        name = re.sub(r"\s+", " ", name)

        group = str(row[C_GROUP] or "")[:1]
        cat = GROUPS.get(group, "Other")

        # AOAC is the modern fibre measure; NSP (Englyst) is the older one
        fib = val(row[C_AOAC])
        if fib is None:
            fib = val(row[C_NSP])

        na = sodium.get(str(code).strip())
        salt = None if na is None else na * 2.5 / 1000  # mg sodium -> g salt

        rec = [
            name, cat,
            r(kcal, 0),
            r(val(row[C_PROT]) or 0, 1),
            r(val(row[C_CHO]) or 0, 1),
            r(val(row[C_FAT]) or 0, 1),
            r(fib, 1),
            r(val(row[C_SUGAR]), 1),
            r(salt, 2),
        ]
        while len(rec) > 6 and rec[-1] is None:   # trim trailing unknowns
            rec.pop()
        out.append(rec)
        stats["kept"] += 1

    out.sort(key=lambda x: x[0].lower())

    body = ",\n".join(json.dumps(rec, ensure_ascii=False) for rec in out)
    print(f"""/* Tally — UK reference foods.
 *
 * Generated from McCance & Widdowson's The Composition of Foods Integrated
 * Dataset (CoFID) 2021, published by Public Health England on gov.uk under the
 * Open Government Licence v3.0.
 *   https://www.gov.uk/government/publications/composition-of-foods-integrated-dataset-cofid
 *
 * Contains public sector information licensed under the Open Government
 * Licence v3.0.  http://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/
 *
 * Do not edit by hand — regenerate with tools/build-cofid.py.
 *
 * Format: [name, category, kcal, protein, carbs, fat, fibre?, sugars?, salt?]
 * All values per 100 g (or 100 ml for drinks). null means not measured.
 * {stats['kept']} foods.
 */
const UK_FOODS = [
{body}
];

if (typeof module !== "undefined") module.exports = {{ UK_FOODS }};""", file=sys.stdout)

    print(
        f"rows={stats['rows']} kept={stats['kept']} "
        f"dropped_no_energy={stats['no_energy']} unparseable_cells={stats['odd']}",
        file=sys.stderr,
    )


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "CoFID.xlsx")
