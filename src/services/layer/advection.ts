/**
 * Advection configuration: which wind params advect which data params
 */

import type { TModelParam } from '../../config/models';

export interface AdvectionConfig {
  uParam: TModelParam;
  vParam: TModelParam;
  targets: TModelParam[];
}
