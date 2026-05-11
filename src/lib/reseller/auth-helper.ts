/**
 * Shared auth + reseller-lookup helper for /api/portal/reseller/* (PR-U1).
 *
 * Most endpoints follow the same shape:
 *   1. cookie-auth → user
 *   2. find reseller row for user (auto-IDOR-safe via WHERE user_id = me)
 *   3. either business logic or 404 if not a reseller
 *
 * Centralized so all 9 endpoints behave consistently and the auth path is
 * single-touch — no chance of one endpoint forgetting the cookie check or
 * the reseller-existence check.
 */
import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth/session';
import type { Reseller } from '@prisma/client';

export interface AuthedResellerCtx {
    userId: string;
    reseller: Reseller;
}

/**
 * Resolve current user + their reseller row. Returns a NextResponse on
 * any failure (caller short-circuits with `return result.response`).
 *
 *   - no session       → 401 invalid_credentials
 *   - user not joined  → 404 not_a_reseller (caller decides whether to expose)
 *
 * Successful path: `{ ctx: { userId, reseller } }`.
 */
export async function getAuthedReseller(
    req: NextRequest,
): Promise<{ ctx: AuthedResellerCtx; response: null } | { ctx: null; response: NextResponse }> {
    const user = await getCurrentUser(req);
    if (!user) {
        return {
            ctx: null,
            response: NextResponse.json({ error: 'invalid_credentials' }, { status: 401 }),
        };
    }
    const reseller = await prisma.reseller.findUnique({ where: { user_id: user.id } });
    if (!reseller) {
        return {
            ctx: null,
            response: NextResponse.json({ error: 'not_a_reseller' }, { status: 404 }),
        };
    }
    return { ctx: { userId: user.id, reseller }, response: null };
}

/**
 * Resolve current user only — for endpoints (like POST /join) that may
 * not have a reseller row yet.
 */
export async function getAuthedUserId(
    req: NextRequest,
): Promise<{ userId: string; response: null } | { userId: null; response: NextResponse }> {
    const user = await getCurrentUser(req);
    if (!user) {
        return {
            userId: null,
            response: NextResponse.json({ error: 'invalid_credentials' }, { status: 401 }),
        };
    }
    return { userId: user.id, response: null };
}
