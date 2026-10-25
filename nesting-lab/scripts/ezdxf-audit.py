#!/usr/bin/env python3
"""Independent check of exported DXF files with ezdxf (strict reader + audit).

    python3 -m venv .venv && .venv/bin/pip install ezdxf
    .venv/bin/python scripts/ezdxf-audit.py out/samples/**/sheet-*.dxf out/samples/**/parts/*.dxf

Prints one line per file: DXF version, $INSUNITS, audit errors/fixes, entity
counts per layer and the extents of the CUT_OUTER contours. Exit code 1 if any
file fails to load strictly or has audit errors.
"""
import sys, collections, glob, os
import ezdxf

paths = []
for arg in sys.argv[1:]:
    paths.extend(sorted(glob.glob(arg, recursive=True)) or [arg])
bad = 0
for path in paths:
    try:
        doc = ezdxf.readfile(path)  # strict: no recovery
    except Exception as e:  # noqa: BLE001
        print(f"{path}: FAILED to load strictly: {e}")
        bad += 1
        continue
    auditor = doc.audit()
    msp = doc.modelspace()
    types = collections.Counter(e.dxftype() for e in msp)
    layers = collections.Counter(e.dxf.layer for e in msp)
    xs, ys = [], []
    for e in msp.query('LWPOLYLINE[layer=="CUT_OUTER"]'):
        for v in e.vertices():
            xs.append(v[0]); ys.append(v[1])
    for e in msp.query('CIRCLE[layer=="CUT_OUTER"]'):
        c = e.dxf.center; r = e.dxf.radius
        xs += [c.x - r, c.x + r]; ys += [c.y - r, c.y + r]
    ext = f"outer extents x {min(xs):.3f}..{max(xs):.3f} y {min(ys):.3f}..{max(ys):.3f}" if xs else "no CUT_OUTER"
    status = "OK" if not auditor.errors else f"AUDIT ERRORS {len(auditor.errors)}"
    if auditor.errors:
        bad += 1
    rel = os.path.relpath(path)
    print(f"{rel}: {status}; {doc.dxfversion}, $INSUNITS={doc.header.get('$INSUNITS')}, fixes={len(auditor.fixes)}; entities {dict(types)}; layers {dict(layers)}; {ext}")
    for err in auditor.errors[:5]:
        print(f"   {err}")
print(f"\n{len(paths)} files checked, {bad} with problems; ezdxf {ezdxf.__version__}")
sys.exit(1 if bad else 0)
