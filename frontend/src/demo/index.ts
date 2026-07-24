import type {
  CalibrationResponse,
  ComparisonResponse,
  RegimeParametersResponse,
  RegimeCurrentResponse,
  RegimeHistoryResponse,
  SurfaceResponse,
} from '../api/types'
import calibration from './calibration.json'
import comparison from './comparison.json'
import current from './current.json'
import history from './history.json'
import parameters from './parameters.json'
import surface from './surface.json'

/**
 * Build-time synthetic responses used as an instant first paint. Live queries still run
 * immediately in the background and replace these values when the API responds.
 */
export const demoData = {
  calibration: calibration as CalibrationResponse,
  comparison: comparison as ComparisonResponse,
  current: current as RegimeCurrentResponse,
  history: history as RegimeHistoryResponse,
  parameters: parameters as RegimeParametersResponse,
  surface: surface as SurfaceResponse,
} as const
