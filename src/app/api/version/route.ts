import { readFile } from 'fs/promises';
import path from 'path';

let cachedBuildId: string | null = null;

// Returns the deployed build id so the client can detect that a new version
// was deployed while the tab was open (stale chunks / server actions) and
// reload itself.
export const GET = async () => {
  try {
    if (!cachedBuildId) {
      cachedBuildId = (
        await readFile(path.join(process.cwd(), '.next', 'BUILD_ID'), 'utf-8')
      ).trim();
    }

    return Response.json({ buildId: cachedBuildId });
  } catch {
    return Response.json({ buildId: null });
  }
};
