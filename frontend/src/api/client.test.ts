import { describe, expect, it } from 'vitest'
import { buildCalibrationWsUrl, healthPath } from './client'

describe('healthPath', () => {
  it('uses the API-readiness proxy for same-origin deployments', () => {
    expect(healthPath('')).toBe('/api-health')
    expect(healthPath('   ')).toBe('/api-health')
  })

  it('uses FastAPI health directly for a configured cross-origin API', () => {
    expect(healthPath('https://api.example.test')).toBe('/health')
  })
})

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
