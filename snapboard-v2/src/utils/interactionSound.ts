// 短促的 UI 敲击声：完全由 Web Audio 合成，不依赖外部音频资源。
let sharedAudioContext: AudioContext | null = null

function getAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null
  const AudioContextCtor = window.AudioContext ??
    (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!AudioContextCtor) return null
  sharedAudioContext ??= new AudioContextCtor()
  return sharedAudioContext
}

/** 在用户成功切换敲落孔状态时播放一次清脆、克制的敲击声。 */
export function playHoleTapSound(): void {
  const ctx = getAudioContext()
  if (!ctx) return
  if (ctx.state === 'suspended') void ctx.resume()

  const now = ctx.currentTime + 0.004

  // 金属/硬塑料的高频“叮”声。
  const ping = ctx.createOscillator()
  const pingGain = ctx.createGain()
  ping.type = 'sine'
  ping.frequency.setValueAtTime(1650, now)
  ping.frequency.exponentialRampToValueAtTime(1180, now + 0.055)
  pingGain.gain.setValueAtTime(0.0001, now)
  pingGain.gain.exponentialRampToValueAtTime(0.16, now + 0.002)
  pingGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.065)
  ping.connect(pingGain).connect(ctx.destination)
  ping.start(now)
  ping.stop(now + 0.07)

  // 极短的高通噪声提供真实敲击的起音，同时保持总体音量较小。
  const noiseLength = Math.max(1, Math.floor(ctx.sampleRate * 0.025))
  const noiseBuffer = ctx.createBuffer(1, noiseLength, ctx.sampleRate)
  const data = noiseBuffer.getChannelData(0)
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1
  const noise = ctx.createBufferSource()
  const highPass = ctx.createBiquadFilter()
  const noiseGain = ctx.createGain()
  noise.buffer = noiseBuffer
  highPass.type = 'highpass'
  highPass.frequency.setValueAtTime(1300, now)
  noiseGain.gain.setValueAtTime(0.055, now)
  noiseGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.025)
  noise.connect(highPass).connect(noiseGain).connect(ctx.destination)
  noise.start(now)
  noise.stop(now + 0.03)
}
