#!/usr/bin/env python3
"""
Run this script on your staff-portal.html to fix the Chats and Gift Cards tabs.
Usage: python3 fix_tabs.py staff-portal.html
Output: staff-portal-fixed.html (ready to use)
"""
import sys, re, os

if len(sys.argv) < 2:
    print("Usage: python3 fix_tabs.py staff-portal.html")
    sys.exit(1)

src = sys.argv[1]
if not os.path.exists(src):
    print(f"Error: file not found: {src}")
    sys.exit(1)

with open(src, 'r', encoding='utf-8') as f:
    html = f.read()

orig_len = len(html)
applied = []

# ── FIX 1: Remove display:none from chats panel ────────────────────────────
old = 'id="panel-chats" style="display:none;padding:0;"'
new = 'id="panel-chats" style="padding:0;"'
if old in html:
    html = html.replace(old, new)
    applied.append("Fix 1: chats panel display:none removed")
else:
    applied.append("Fix 1: SKIPPED (already fixed or not found)")

# ── FIX 2: Remove display:none from giftcards panel ────────────────────────
old = 'id="panel-giftcards" style="display:none"'
new = 'id="panel-giftcards"'
if old in html:
    html = html.replace(old, new)
    applied.append("Fix 2: giftcards panel display:none removed")
else:
    applied.append("Fix 2: SKIPPED (already fixed or not found)")

# ── FIX 3: Patch showPanel to clear inline styles when switching tabs ───────
# The .panel.active CSS cannot override inline display:none, so we patch
# showPanel to explicitly set display:none/block on panels.

# Patch the forEach that removes 'active' class - add style.display='none'
old = "document.querySelectorAll('.panel').forEach(p=>p.classList.remove('active'));"
new = "document.querySelectorAll('.panel').forEach(p=>{p.classList.remove('active');p.style.display='none';});"
if old in html:
    html = html.replace(old, new)
    applied.append("Fix 3a: showPanel forEach now hides panels with inline style")
else:
    applied.append("Fix 3a: SKIPPED (not found or already patched)")

# Patch the line that adds 'active' to the target panel - also set display:block
old = "document.getElementById('panel-'+n).classList.add('active');"
new = "const _activePanel=document.getElementById('panel-'+n);if(_activePanel){_activePanel.classList.add('active');_activePanel.style.display='block';}"
if old in html:
    html = html.replace(old, new)
    applied.append("Fix 3b: showPanel now sets display:block on active panel")
else:
    applied.append("Fix 3b: SKIPPED (not found or already patched)")

# ── FIX 4: Add giftcards loader if missing ──────────────────────────────────
if "n==='giftcards'" not in html:
    old = "if(n==='chats'){loadChats();}"
    new = "if(n==='chats'){loadChats();}\n  if(n==='giftcards'){gcCargar('todas');}"
    if old in html:
        html = html.replace(old, new)
        applied.append("Fix 4: gcCargar('todas') added for giftcards tab")
    else:
        applied.append("Fix 4: SKIPPED (chats handler not found)")
else:
    applied.append("Fix 4: SKIPPED (giftcards loader already present)")

# ── FIX 5: Remove broken DOMContentLoaded override ──────────────────────────
# This block re-wraps showPanel but calls origShow before the reassignment
# loop is complete, causing issues
pattern = r"document\.addEventListener\s*\(\s*'DOMContentLoaded'\s*,\s*\(\s*\)\s*=>\s*\{[^}]*const origShow[^}]*window\.showPanel[^}]*\}[^}]*\}\s*\)\s*;"
match = re.search(pattern, html, re.DOTALL)
if match:
    html = html[:match.start()] + '/* tab fix applied above */' + html[match.end():]
    applied.append("Fix 5: broken DOMContentLoaded override removed")
else:
    applied.append("Fix 5: SKIPPED (DOMContentLoaded block not found)")

# ── Write output ─────────────────────────────────────────────────────────────
out = src.replace('.html', '-fixed.html')
if out == src:
    out = 'staff-portal-fixed.html'

with open(out, 'w', encoding='utf-8') as f:
    f.write(html)

print("\nStaff Portal Fix — Results")
print("=" * 50)
for msg in applied:
    status = "✅" if "SKIPPED" not in msg else "⚠️ "
    print(f"  {status} {msg}")
print("=" * 50)
print(f"  Input:  {src} ({orig_len:,} bytes)")
print(f"  Output: {out} ({len(html):,} bytes)")
print(f"\n  Done! Open {out} in your browser to test.")