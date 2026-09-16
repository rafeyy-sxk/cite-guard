import { NextResponse } from 'next/server';
import { resolveModels } from '@/lib/groq';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The live model catalogue.
 *
 * Surfaced in the UI so the choice is visible rather than implied: the app shows
 * which model it is about to use and where that name came from.
 */
export async function GET(): Promise<NextResponse> {
  try {
    const models = await resolveModels();
    return NextResponse.json({
      draft: models.draft,
      verify: models.verify,
      available: models.available,
    });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 502 });
  }
}
