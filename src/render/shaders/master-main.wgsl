// Master shader - processed by wgsl-plus
// Includes all shader modules in dependency order

// Preserve entry points during obfuscation
#entrypoint "vs_main"
#entrypoint "fs_main"

#include "sun-atmo.wgsl"
#include "common.wgsl"
#include "logo.wgsl"
#include "temp.wgsl"
#include "rain.wgsl"
#include "base.wgsl"
#include "sun.wgsl"
#include "grid.wgsl"
#include "grid-text.wgsl"
#include "sun-blend.wgsl"
#include "main.wgsl"
