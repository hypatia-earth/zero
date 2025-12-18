// Parallel Prefix Sum (Exclusive Scan)
// Harris/Blelloch algorithm - work-efficient O(n) scan
// Reference: https://www.eecs.umich.edu/courses/eecs570/hw/parprefix.pdf
//
// Used to compute output offsets for marching squares:
// Input:  [1, 2, 0, 1, 1, 0, 2, 1]  (segment counts per cell)
// Output: [0, 1, 3, 3, 4, 5, 5, 7]  (write offsets)

@group(0) @binding(0) var<storage, read_write> vals: array<u32>;
@group(0) @binding(1) var<storage, read_write> blockSums: array<u32>;

// Block size for scan - must match workgroup dispatch
// 512 elements per workgroup, 256 threads (each handles 2 elements)
const SCAN_BLOCK_SIZE: u32 = 512u;

var<workgroup> chunk: array<u32, 512>;  // SCAN_BLOCK_SIZE

@compute @workgroup_size(256)  // SCAN_BLOCK_SIZE / 2
fn scanBlocks(
  @builtin(global_invocation_id) globalId: vec3<u32>,
  @builtin(local_invocation_id) localId: vec3<u32>,
  @builtin(workgroup_id) groupId: vec3<u32>
) {
  // Load 2 elements per thread into shared memory
  chunk[2u * localId.x] = vals[2u * globalId.x];
  chunk[2u * localId.x + 1u] = vals[2u * globalId.x + 1u];

  var offset = 1u;

  // Up-sweep (reduce) phase - build sum tree
  for (var d = SCAN_BLOCK_SIZE >> 1u; d > 0u; d = d >> 1u) {
    workgroupBarrier();
    if (localId.x < d) {
      let a = offset * (2u * localId.x + 1u) - 1u;
      let b = offset * (2u * localId.x + 2u) - 1u;
      chunk[b] += chunk[a];
    }
    offset = offset << 1u;
  }

  // Store block sum and clear last element for exclusive scan
  if (localId.x == 0u) {
    blockSums[groupId.x] = chunk[SCAN_BLOCK_SIZE - 1u];
    chunk[SCAN_BLOCK_SIZE - 1u] = 0u;
  }

  // Down-sweep phase - distribute partial sums
  for (var d = 1u; d < SCAN_BLOCK_SIZE; d = d << 1u) {
    offset = offset >> 1u;
    workgroupBarrier();
    if (localId.x < d) {
      let a = offset * (2u * localId.x + 1u) - 1u;
      let b = offset * (2u * localId.x + 2u) - 1u;
      let tmp = chunk[a];
      chunk[a] = chunk[b];
      chunk[b] += tmp;
    }
  }

  workgroupBarrier();

  // Write results back
  vals[2u * globalId.x] = chunk[2u * localId.x];
  vals[2u * globalId.x + 1u] = chunk[2u * localId.x + 1u];
}

// Add block sums to complete the scan across blocks
// Run after scanBlocks has been applied to blockSums buffer
@compute @workgroup_size(256)
fn addBlockSums(
  @builtin(global_invocation_id) globalId: vec3<u32>,
  @builtin(workgroup_id) groupId: vec3<u32>
) {
  // Skip first block (no block sum to add)
  if (groupId.x == 0u) { return; }

  let blockSum = blockSums[groupId.x];
  vals[2u * globalId.x] += blockSum;
  vals[2u * globalId.x + 1u] += blockSum;
}
