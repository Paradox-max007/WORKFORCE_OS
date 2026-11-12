#!/usr/bin/env python3
"""Add the Branches column + BranchAccessDialog to admin-page.tsx (idempotent)."""

path = '/home/z/my-project/src/components/admins/admin-page.tsx'
src = open(path, encoding='utf-8').read()
applied = []

def sub(old, new, tag):
    global src
    if new in src:
        applied.append(f'{tag} already applied')
    elif old in src:
        src = src.replace(old, new)
        applied.append(f'{tag} applied')
    else:
        raise SystemExit(f'{tag}: target not found')

# ---- 1. Desktop table: header column ----
sub(
    """                      <TableHead className={TH}>Access</TableHead>
                      <TableHead className={TH}>Assigned Sites</TableHead>""",
    """                      <TableHead className={TH}>Access</TableHead>
                      <TableHead className={TH}>Branches</TableHead>
                      <TableHead className={TH}>Assigned Sites</TableHead>""",
    '1 header',
)

# ---- 2. Desktop table: row cell ----
sub(
    """                        <TableCell className="px-3 py-3">
                          <AccessChips map={permCache[p.id]} />
                        </TableCell>
                        <TableCell className="px-3 py-3">
                          <SiteChips siteIds={sitesCache[p.id] ?? []} sites={sites} />
                        </TableCell>""",
    """                        <TableCell className="px-3 py-3">
                          <AccessChips map={permCache[p.id]} />
                        </TableCell>
                        <TableCell className="px-3 py-3">
                          <BranchChips branchIds={branchesCache[p.id] ?? []} branches={branches} />
                        </TableCell>
                        <TableCell className="px-3 py-3">
                          <SiteChips siteIds={sitesCache[p.id] ?? []} sites={sites} />
                        </TableCell>""",
    '2 row cell',
)

# ---- 3. Desktop RowActions: add onBranches ----
sub(
    """                            <RowActions
                              profile={p}
                              canDelete
                              onEdit={() => setAccountTarget({ mode: 'edit', profile: p })}
                              onPermissions={() => setPermTarget(p)}
                              onSites={() => setSitesTarget(p)}
                              onDelete={() => requestDelete(p)}
                            />""",
    """                            <RowActions
                              profile={p}
                              canDelete
                              onEdit={() => setAccountTarget({ mode: 'edit', profile: p })}
                              onPermissions={() => setPermTarget(p)}
                              onBranches={() => setBranchesTarget(p)}
                              onSites={() => setSitesTarget(p)}
                              onDelete={() => requestDelete(p)}
                            />""",
    '3 desktop actions',
)

# ---- 4. Mobile card: branch chips line ----
sub(
    """                      <p className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                        <Building2 size={12} className="shrink-0 text-brand" aria-hidden /> Sites:
                        <SiteChips siteIds={sitesCache[p.id] ?? []} sites={sites} inline />
                      </p>""",
    """                      <p className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                        <GitBranch size={12} className="shrink-0 text-brand" aria-hidden /> Branches:
                        <BranchChips branchIds={branchesCache[p.id] ?? []} branches={branches} inline />
                      </p>
                      <p className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                        <Building2 size={12} className="shrink-0 text-brand" aria-hidden /> Sites:
                        <SiteChips siteIds={sitesCache[p.id] ?? []} sites={sites} inline />
                      </p>""",
    '4 mobile chips',
)

# ---- 5. Mobile RowActions ----
sub(
    """                        <RowActions
                          profile={p}
                          canDelete
                          onEdit={() => setAccountTarget({ mode: 'edit', profile: p })}
                          onPermissions={() => setPermTarget(p)}
                          onSites={() => setSitesTarget(p)}
                          onDelete={() => requestDelete(p)}
                        />""",
    """                        <RowActions
                          profile={p}
                          canDelete
                          onEdit={() => setAccountTarget({ mode: 'edit', profile: p })}
                          onPermissions={() => setPermTarget(p)}
                          onBranches={() => setBranchesTarget(p)}
                          onSites={() => setSitesTarget(p)}
                          onDelete={() => requestDelete(p)}
                        />""",
    '5 mobile actions',
)

# ---- 6. Render the BranchAccessDialog next to the SiteAccessDialog ----
sub(
    """      {/* ---- Site access dialog ---- */}
      <SiteAccessDialog
        profile={sitesTarget}
        sites={sites}
        onClose={() => setSitesTarget(null)}
        onChanged={handleSitesChanged}
      />""",
    """      {/* ---- Branch access dialog ---- */}
      <BranchAccessDialog
        profile={branchesTarget}
        branches={branches}
        onClose={() => setBranchesTarget(null)}
        onChanged={handleBranchesChanged}
      />

      {/* ---- Site access dialog ---- */}
      <SiteAccessDialog
        profile={sitesTarget}
        sites={sites}
        onClose={() => setSitesTarget(null)}
        onChanged={handleSitesChanged}
      />""",
    '6 dialog render',
)

# ---- 7. RowActions component: accept + render the branches button ----
sub(
    """/** Row action icon buttons (permissions + site access for admins, edit, guarded delete). */
function RowActions({
  profile, canDelete, onEdit, onPermissions, onSites, onDelete,
}: {
  profile: Profile;
  canDelete: boolean;
  onEdit: () => void;
  onPermissions?: () => void;
  onSites?: () => void;
  onDelete: () => void;
}) {""",
    """/** Row action icon buttons (permissions + branch/site access for admins, edit, guarded delete). */
function RowActions({
  profile, canDelete, onEdit, onPermissions, onBranches, onSites, onDelete,
}: {
  profile: Profile;
  canDelete: boolean;
  onEdit: () => void;
  onPermissions?: () => void;
  onBranches?: () => void;
  onSites?: () => void;
  onDelete: () => void;
}) {""",
    '7 RowActions props',
)

sub(
    """      {onSites && (
        <Button
          variant="ghost"
          size="icon"
          onClick={onSites}
          title="Assign sites (attendance scoping)"
          aria-label={`Assign sites — ${profile.name}`}
          className="size-9 text-muted-foreground hover:bg-emerald-500/10 hover:text-emerald-500"
        >
          <Building2 size={15} aria-hidden />
        </Button>
      )}""",
    """      {onBranches && (
        <Button
          variant="ghost"
          size="icon"
          onClick={onBranches}
          title="Assign branches (branch access)"
          aria-label={`Assign branches — ${profile.name}`}
          className="size-9 text-muted-foreground hover:bg-brand/10 hover:text-brand"
        >
          <GitBranch size={15} aria-hidden />
        </Button>
      )}
      {onSites && (
        <Button
          variant="ghost"
          size="icon"
          onClick={onSites}
          title="Assign sites (attendance scoping)"
          aria-label={`Assign sites — ${profile.name}`}
          className="size-9 text-muted-foreground hover:bg-emerald-500/10 hover:text-emerald-500"
        >
          <Building2 size={15} aria-hidden />
        </Button>
      )}""",
    '8 RowActions button',
)

# ---- 9. BranchChips component (before SiteChips) ----
sub(
    """/** Summary of the sites an admin is assigned to (attendance scoping). */
function SiteChips({""",
    """/** Summary of the branches an admin may access (branch scoping). */
function BranchChips({
  branchIds, branches, inline = false,
}: {
  branchIds: string[];
  branches: BranchWithCount[] | null;
  inline?: boolean;
}) {
  const names = (branches ?? []).filter((b) => branchIds.includes(b.id)).map((b) => b.name);
  return (
    <span
      className={cn('flex items-center gap-1', inline ? 'flex-wrap' : 'max-w-[220px] flex-wrap')}
      title="Admins only see the branches assigned to them"
    >
      {names.length === 0 ? (
        <span className={cn('rounded-full border px-1.5 py-px text-[10px] font-medium', inline ? 'text-amber-600 dark:text-amber-400 border-amber-500/25 bg-amber-500/10' : 'text-muted-foreground bg-muted')}>
          All / none
        </span>
      ) : names.map((n) => (
        <span
          key={n}
          className="rounded-full border border-brand/25 bg-brand/10 px-1.5 py-px text-[10px] font-medium text-brand"
        >
          {n}
        </span>
      ))}
    </span>
  );
}

/** Summary of the sites an admin is assigned to (attendance scoping). */
function SiteChips({""",
    '9 BranchChips',
)

open(path, 'w', encoding='utf-8').write(src)
print('; '.join(applied))
