#!/usr/bin/env python3
"""Apply the remaining branch edits to admin-page.tsx (idempotent)."""
import re

path = '/home/z/my-project/src/components/admins/admin-page.tsx'
src = open(path, encoding='utf-8').read()
applied = []

# 1. Load branches alongside profiles/sites
old1 = """        const [list, siteList] = await Promise.all([dataApi.listProfiles(), dataApi.listSites()]);
        if (cancelled) return;
        setProfiles(list);
        setSites(siteList);"""
new1 = """        const [list, siteList, branchList] = await Promise.all([
          dataApi.listProfiles(),
          dataApi.listSites(),
          dataApi.listBranches().catch(() => [] as BranchWithCount[]),
        ]);
        if (cancelled) return;
        setProfiles(list);
        setSites(siteList);
        setBranches(branchList);"""
if new1 in src:
    applied.append('1 already applied')
elif old1 in src:
    src = src.replace(old1, new1)
    applied.append('1 applied')
else:
    raise SystemExit('edit 1 target not found')

# 2. comment tweak
old2 = "        // Permission summaries + site assignments for the admin rows\n"
new2 = "        // Permission summaries + site/branch assignments for the admin rows\n"
if new2 in src:
    applied.append('2 already applied')
elif old2 in src:
    src = src.replace(old2, new2)
    applied.append('2 applied')
else:
    applied.append('2 SKIP (comment not found — ok)')

# 3. Add the branch assignments Promise.all block
old3 = """                try {
                  return [p.id, await dataApi.getSiteAssignments(p.id)];
                } catch {
                  return [p.id, [] as string[]];
                }
              }),
          ),
        ]);
        if (!cancelled) {
          setPermCache(Object.fromEntries(maps));
          setSitesCache(Object.fromEntries(siteSets));
        }"""
new3 = """                try {
                  return [p.id, await dataApi.getSiteAssignments(p.id)];
                } catch {
                  return [p.id, [] as string[]];
                }
              }),
          ),
          Promise.all(
            list
              .filter((p) => p.role === 'admin')
              .map(async (p): Promise<[string, string[]]> => {
                try {
                  return [p.id, await dataApi.getBranchAssignments(p.id)];
                } catch {
                  return [p.id, [] as string[]];
                }
              }),
          ),
        ]);
        if (!cancelled) {
          setPermCache(Object.fromEntries(maps));
          setSitesCache(Object.fromEntries(siteSets));
          setBranchesCache(Object.fromEntries(branchSets));
        }"""
if 'getBranchAssignments(p.id)' in src:
    applied.append('3 already applied')
elif old3 in src:
    src = src.replace(old3, new3)
    applied.append('3 applied')
else:
    raise SystemExit('edit 3 target not found')

# 4. handleBranchesChanged
old4 = """  const handleSitesChanged = (profileId: string, siteIds: string[]) => {
    setSitesCache((prev) => ({ ...prev, [profileId]: siteIds }));
  };"""
new4 = """  const handleSitesChanged = (profileId: string, siteIds: string[]) => {
    setSitesCache((prev) => ({ ...prev, [profileId]: siteIds }));
  };

  // Keep the "Branches" column in sync when toggles fire in the branch dialog
  const handleBranchesChanged = (profileId: string, branchIds: string[]) => {
    setBranchesCache((prev) => ({ ...prev, [profileId]: branchIds }));
  };"""
if 'handleBranchesChanged' in src:
    applied.append('4 already applied')
elif old4 in src:
    src = src.replace(old4, new4)
    applied.append('4 applied')
else:
    raise SystemExit('edit 4 target not found')

open(path, 'w', encoding='utf-8').write(src)
print('; '.join(applied))
