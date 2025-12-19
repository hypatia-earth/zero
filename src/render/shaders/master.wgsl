// Master shader - processed by wgsl-plus
// Includes all shader modules in dependency order

// Preserve entry points during obfuscation
#entrypoint "vs_main"
#entrypoint "fs_main"

#include "atmosphere.wgsl"
#include "common.wgsl"
#include "logo.wgsl"
#include "temperature.wgsl"
#include "rain.wgsl"
#include "basemap.wgsl"
#include "sun.wgsl"
#include "grid.wgsl"
#include "grid-text.wgsl"
#include "atmosphere-blend.wgsl"
#include "globe.wgsl"
