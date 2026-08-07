// Browser-side solver for the upstream SHA-1 proof-of-work challenge.
// The worker delegates the challenge to the browser (503 + challenge JSON),
// the browser solves it here and POSTs the token back to the worker, which
// stores it in the upstream session jar. Mirrors src/challenge.js.

export interface Challenge {
  salt: string
  index: number
  byteA: number
  byteB: number
}

export interface ChallengeSolution {
  token: string
  seconds: number
}

const BATCH_SIZE = 256
const MAX_ITERATIONS = 1_200_000
const WALL_CLOCK_BUDGET_MS = 15_000

function writeCandidate(block: Uint8Array, saltBytes: Uint8Array, i: number): number {
  block.set(saltBytes)
  let value = i
  let digits = 1
  while (value >= 10) {
    value = Math.floor(value / 10)
    digits += 1
  }
  value = i
  for (let p = digits - 1; p >= 0; p -= 1) {
    block[saltBytes.length + p] = 0x30 + (value % 10)
    value = Math.floor(value / 10)
  }
  return saltBytes.length + digits
}

export async function solveChallenge(
  challenge: Challenge,
): Promise<ChallengeSolution | null> {
  const { salt, index, byteA, byteB } = challenge
  const saltBytes = new TextEncoder().encode(salt)
  const template = new Uint8Array(64)
  const startedAt = performance.now()

  for (let base = 0; base < MAX_ITERATIONS; base += BATCH_SIZE) {
    const jobs: Promise<ArrayBuffer>[] = []
    const end = Math.min(base + BATCH_SIZE, MAX_ITERATIONS)
    for (let i = base; i < end; i += 1) {
      const length = writeCandidate(template, saltBytes, i)
      jobs.push(crypto.subtle.digest("SHA-1", template.subarray(0, length)))
    }

    let digests: ArrayBuffer[]
    try {
      digests = await Promise.all(jobs)
    } catch {
      return null
    }

    for (let k = 0; k < digests.length; k += 1) {
      const bytes = new Uint8Array(digests[k])
      if (bytes[index] === byteA && bytes[index + 1] === byteB) {
        return {
          token: `${salt}${base + k}`,
          seconds: (performance.now() - startedAt) / 1000,
        }
      }
    }

    if (performance.now() - startedAt > WALL_CLOCK_BUDGET_MS) {
      return null
    }
  }

  return null
}

export async function submitChallengeSolution(solution: ChallengeSolution): Promise<void> {
  const response = await fetch("/__z/api/challenge", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(solution),
  })
  if (!response.ok) {
    throw new Error(`Challenge submission failed with status ${response.status}`)
  }
}
