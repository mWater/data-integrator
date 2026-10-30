"""License compliance gate for the Python runtime image: every installed
distribution must carry an OSI-approved license. Runs inside the image
(python3 scripts/check-python-licenses.py) and reads package metadata: an SPDX
License-Expression, an "OSI Approved" trove classifier, or a License field
naming an allowed license. Exits nonzero listing any package that has none.
"""

import re
import sys
from importlib.metadata import distributions

# SPDX identifiers accepted in License-Expression and License fields; the same
# set as scripts/check-licenses.mjs
ALLOWED = {
    "Apache-2.0", "MIT", "ISC", "BSD-2-Clause", "BSD-3-Clause", "0BSD",
    "BlueOak-1.0.0", "CC0-1.0", "Unlicense", "Zlib", "Python-2.0",
    "MPL-2.0", "PostgreSQL", "CC-BY-4.0", "CC-BY-3.0", "WTFPL", "MIT-0",
    "Artistic-2.0", "LGPL-3.0", "LGPL-3.0-only", "LGPL-3.0-or-later", "LGPL-2.1", "LGPL-2.1-only",
    "LGPL-2.1-or-later", "PSF-2.0", "HPND",
}

# Common non-SPDX spellings in License fields, mapped to their SPDX identifier
ALIASES = {
    "apache 2.0": "Apache-2.0", "apache-2": "Apache-2.0", "apache software license": "Apache-2.0",
    "apache license 2.0": "Apache-2.0", "apache license, version 2.0": "Apache-2.0",
    "bsd": "BSD-3-Clause", "bsd license": "BSD-3-Clause", "3-clause bsd": "BSD-3-Clause",
    "new bsd": "BSD-3-Clause", "mit license": "MIT", "psf": "PSF-2.0", "mpl 2.0": "MPL-2.0",
}

# Wheels published without license metadata, with the license their upstream
# project states. Each entry names where that was checked.
UNLABELLED = {
    "eccodeslib": "Apache-2.0",  # ECMWF ecCodes binary wheel (github.com/ecmwf/eccodes, LICENSE)
    "eckitlib": "Apache-2.0",  # ECMWF eckit binary wheel (github.com/ecmwf/eckit, LICENSE)
}


def candidates(expression):
    """SPDX ids in an expression like "(MIT OR Apache-2.0)"."""
    return [part for part in re.split(r"[()\s]+|\s+(?:OR|AND|WITH)\s+", expression) if part and part not in ("OR", "AND", "WITH")]


def allowed_expression(expression):
    ids = candidates(expression)
    if " OR " in expression:
        return any(i in ALLOWED for i in ids)
    return bool(ids) and all(i in ALLOWED for i in ids)


def verdict(meta):
    """The license a distribution is accepted under, or None."""
    expression = meta.get("License-Expression")
    if expression:
        return expression if allowed_expression(expression) else None
    osi = [c.split("::")[-1].strip() for c in meta.get_all("Classifier") or [] if c.startswith("License :: OSI Approved")]
    if osi:
        return "; ".join(osi)
    field = (meta.get("License") or "").strip()
    first_line = field.splitlines()[0].strip() if field else ""
    spdx = ALIASES.get(first_line.lower(), first_line)
    if spdx and allowed_expression(spdx):
        return spdx
    return None


violations = []
count = 0
for dist in distributions():
    name = dist.metadata.get("Name") or "?"
    count += 1
    if verdict(dist.metadata) is None and (name.lower() not in UNLABELLED or dist.metadata.get("License")):
        field = (dist.metadata.get("License") or "").strip().splitlines()
        violations.append(f"{name}=={dist.version}: {dist.metadata.get('License-Expression') or (field[0] if field else 'no license metadata')}")

if violations:
    print(f"Python packages without an OSI-approved license ({len(violations)}):", file=sys.stderr)
    for line in sorted(violations):
        print(f"  {line}", file=sys.stderr)
    sys.exit(1)
print(f"All {count} Python packages carry OSI-approved licenses.")
