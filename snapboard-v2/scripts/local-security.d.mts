import type { IncomingMessage } from 'node:http'
import type { Plugin } from 'vite'
export const privateFileGlobs: string[]
export function localRequestProblem(request: IncomingMessage): { status: number; error: string } | null
export function localSecurityPlugin(): Plugin
