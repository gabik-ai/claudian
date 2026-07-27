/**
 * Read a file as it exists on the pristine upstream mirror (`origin/main`).
 *
 * Every obsolescence guard needs this: it compares our patched tree against
 * what upstream actually ships today, so the guard turns red the moment
 * upstream implements the thing itself and our patch becomes dead weight.
 *
 * The tricky part is the failure mode. A shallow checkout has no `origin/main`,
 * and a guard that quietly skips in that case is a guard that always passes —
 * exactly the falsely-green check we are trying to avoid. So:
 *
 *   - locally, a missing ref means "skip", because a single-branch clone is a
 *     legitimate way to work on this repo;
 *   - in CI, `MAZEL_REQUIRE_UPSTREAM_REF=1` turns the same situation into a
 *     hard failure. CI is the place where the guards must genuinely run.
 */
import { execFileSync } from 'child_process';
import { join } from 'path';

export const REPO_ROOT = join(__dirname, '..', '..', '..');

export const UPSTREAM_REF = process.env.MAZEL_UPSTREAM_REF ?? 'origin/main';

/** Returns the file contents, or null when the upstream ref is unavailable. */
export function readUpstreamFile(relativePath: string): string | null {
  try {
    return execFileSync('git', ['show', `${UPSTREAM_REF}:${relativePath}`], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (error) {
    if (process.env.MAZEL_REQUIRE_UPSTREAM_REF === '1') {
      throw new Error(
        `Obsoleszenz-Wächter kann ${UPSTREAM_REF}:${relativePath} nicht lesen. ` +
        'In CI ist das ein Fehler, kein Grund zum Überspringen — ' +
        'actions/checkout braucht fetch-depth: 0 plus einen expliziten fetch von main. ' +
        `Ursache: ${(error as Error).message}`,
        { cause: error },
      );
    }
    return null;
  }
}
