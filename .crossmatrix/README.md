# .crossmatrix — repo-committed model store

This directory is crossmatrix's model store and is **meant to be committed**
to version control. The model travels with the repository.

Layout:

- `config/<configId>@<version>.json` — methodology: scales, relation
  declarations, contractions.
- `dimensions/<dimensionSetId>@<version>.json` — members/rosters.
- `state/<stateId>.json` — cells/observations plus a monotonic `revision`.
- `audit/<stateId>.jsonl` — append-only mutation log; union-merged.

All files are canonical JSON (object keys sorted) so diffs stay minimal and
merge-friendly. `audit/*.jsonl` uses `merge=union` (see `.gitattributes`).

Findings are computed and are never stored here.

Validate the store with:

    crossmatrix-mcp check

See the crossmatrix ADRs (0002–0004) for the engine and schema design.
