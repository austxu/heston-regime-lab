import { describe, expect, it } from 'vitest'
import { buildCalibrationWsUrl } from './client'

describe('buildCalibrationWsUrl', () => {
  it('uses the current secure origin when no API base is configured', () => {
    expect(buildCalibrationWsUrl('', 'https://lab.example/dashboard', false)).toBe(
      'wss://lab.example/ws/calibration?live=false',
    )
  })

  it('normalizes a full API origin and its trailing slash', () => {
    expect(buildCalibrationWsUrl('http://api.example.test/', 'https://lab.example/', true)).toBe(
      'ws://api.example.test/ws/calibration',
    )
  })

  it('preserves a base path for relative and absolute API bases', () => {
    expect(buildCalibrationWsUrl('/backend/', 'https://lab.example/app', true)).toBe(
      'wss://lab.example/backend/ws/calibration',
    )
    expect(
      buildCalibrationWsUrl('https://api.example.test/gateway/', 'https://lab.example/', false),
    ).toBe('wss://api.example.test/gateway/ws/calibration?live=false')
  })
})
