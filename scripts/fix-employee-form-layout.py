#!/usr/bin/env python3
"""Fix Edit Employee Details card arrangement.

Problem: flat `lg:grid-cols-2` grid — the tall Work & Accommodation card
(row 2, left) stretches the whole grid row, leaving a big void under the
short Historical Working Hours card (row 2, right), so Documents (row 3)
is pushed far down.

Fix: explicit cell placement + one wrapper div (pinned right column,
row 2) that stacks Historical Working Hours and Documents tightly, so
Documents sits directly below Historical Working Hours, beside the
Work & Accommodation card. Mobile (below lg) DOM order is unchanged.
"""
import sys

P = '/home/z/my-project/src/components/employees/employee-form-page.tsx'
s = open(P).read()


def sub1(old: str, new: str) -> None:
    global s
    n = s.count(old)
    assert n == 1, f"marker count={n} (expected 1): {old[:70]!r}"
    s = s.replace(old, new)


# --- 1. Identity -> left column, row 1
sub1(
    '<FormSection icon={<UserRound size={16} />} title="Identity" hint="Name, Employee ID, nationality & photo">',
    '<FormSection icon={<UserRound size={16} />} title="Identity" hint="Name, Employee ID, nationality & photo" className="lg:col-start-1 lg:row-start-1">',
)

# --- 2. Personal & Contact -> right column, row 1
sub1(
    '<FormSection icon={<HeartPulse size={16} />} title="Personal & Contact" hint="Birth date, phones and home-country address">',
    '<FormSection icon={<HeartPulse size={16} />} title="Personal & Contact" hint="Birth date, phones and home-country address" className="lg:col-start-2 lg:row-start-1">',
)

# --- 3. Work & Accommodation -> left column, row 2
sub1(
    '<FormSection icon={<Building2 size={16} />} title="Work & Accommodation" hint="Trade, site, camp with block & room">',
    '<FormSection icon={<Building2 size={16} />} title="Work & Accommodation" hint="Trade, site, camp with block & room" className="lg:col-start-1 lg:row-start-2">',
)

# --- 4. Documents: the wrapper now owns placement, drop the col-start class
sub1(
    '''          {/* ---------------- Documents ----------------
              Stacked BELOW the Historical Working Hours card, i.e. it lives in
              the RIGHT column — the column that runs next to Work &
              Accommodation on the left. */}
          <FormSection
            icon={<IdCard size={16} />}
            title="Documents"
            hint="Passport, ID & payment method"
            className="lg:col-start-2"
          >''',
    '''          {/* ---------------- Documents ----------------
              Directly below Historical Working Hours inside the same
              right-column wrapper — tight stack, no stretched-grid void. */}
          <FormSection
            icon={<IdCard size={16} />}
            title="Documents"
            hint="Passport, ID & payment method"
          >''',
)

# --- 5. Re-indent the Historical..Documents block (+2 spaces, it gains a wrapper level)
hist_comment = '          {/* ---------------- Historical Working Hours ---------------- */}'
assert s.count(hist_comment) == 1
hist_start = s.index(hist_comment)

close_marker = '          </FormSection>\n        </div>\n      )}'
assert s.count(close_marker) == 1, 'Documents close + grid close not found'
block_end = s.index(close_marker) + len('          </FormSection>\n')

block = s[hist_start:block_end]
indented = '\n'.join(('  ' + ln if ln.strip() else ln) for ln in block.split('\n'))
s = s[:hist_start] + indented + s[block_end:]

# --- 6. Open the wrapper right before the Historical comment
wrapper_open = '''          {/* ------------- Historical Working Hours + Documents -------------
              Both cards share ONE wrapper pinned to the RIGHT column (row 2),
              so Documents stacks directly under Historical Working Hours with
              the normal card gap. The tall Work & Accommodation card on the
              left can no longer stretch this grid row and push Documents down.
              Below lg everything stays a single column in the same DOM order. */}
          <div className="grid gap-5 lg:col-start-2 lg:row-start-2">
'''
indented_hist_comment = '  ' + hist_comment  # now 12-space indented
assert s.count(indented_hist_comment) == 1
s = s.replace(indented_hist_comment, wrapper_open + indented_hist_comment)

# --- 7. Close the wrapper right after the Documents </FormSection>
new_close = '            </FormSection>\n        </div>\n      )}'
assert s.count(new_close) == 1, 're-indented Documents close not found'
s = s.replace(new_close, '            </FormSection>\n          </div>\n        </div>\n      )}')

open(P, 'w').write(s)
print('OK — layout fix applied')
