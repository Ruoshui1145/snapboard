import assert from 'node:assert/strict'

// 配方网格边缘清理（实施日志 §8/§13.2）：孤立小连通域归并进邻域主配方。
// 纯网格逻辑，不依赖 sharp/LUT，用合成网格直接测。
const { despeckleRecipeGrid } = await import('./native-recipe-raster.mjs')

const grid = (rows) => {
  const height = rows.length
  const width = rows[0].length
  const ids = new Uint16Array(width * height)
  rows.forEach((row, y) => row.forEach((value, x) => { ids[y * width + x] = value }))
  return { ids, width, height }
}
const rows = (ids, width) => {
  const out = []
  for (let y = 0; y < ids.length / width; y++) out.push([...ids.slice(y * width, (y + 1) * width)])
  return out
}

// 1. 单格碎斑改判为邻域主配方（四邻多数票：背景 1 有三票，异色 2 只有一票）。
{
  const { ids, width, height } = grid([
    [1, 1, 1, 1],
    [1, 9, 1, 2],
    [1, 1, 1, 2],
    [2, 2, 2, 2],
  ])
  const stats = despeckleRecipeGrid(ids, width, height, 3)
  assert.deepEqual(rows(ids, width), [
    [1, 1, 1, 1],
    [1, 1, 1, 2],
    [1, 1, 1, 2],
    [2, 2, 2, 2],
  ])
  assert.deepEqual(stats, { mergedComponents: 1, mergedCells: 1 })
}

// 2. 阈值内的多格碎斑整体归并；超过阈值的区域保留。
{
  const { ids, width, height } = grid([
    [1, 1, 1, 1, 1, 1, 1],
    [1, 5, 5, 1, 7, 7, 1],
    [1, 5, 5, 1, 7, 7, 1],
    [1, 1, 1, 1, 7, 7, 1],
    [1, 1, 1, 1, 1, 1, 1],
  ])
  const stats = despeckleRecipeGrid(ids, width, height, 4)
  assert.deepEqual(rows(ids, width), [
    [1, 1, 1, 1, 1, 1, 1],
    [1, 1, 1, 1, 7, 7, 1],
    [1, 1, 1, 1, 7, 7, 1],
    [1, 1, 1, 1, 7, 7, 1],
    [1, 1, 1, 1, 1, 1, 1],
  ])
  assert.deepEqual(stats, { mergedComponents: 1, mergedCells: 4 })
}

// 3. 一格子宽的细长线条：连通域大，必须保留（不能把设计里的细线当碎斑吃掉）。
{
  const { ids, width, height } = grid([
    [1, 1, 1, 1, 1, 1],
    [3, 3, 3, 3, 3, 3],
    [1, 1, 1, 1, 1, 1],
  ])
  const stats = despeckleRecipeGrid(ids, width, height, 4)
  assert.deepEqual(rows(ids, width)[1], [3, 3, 3, 3, 3, 3])
  assert.deepEqual(stats, { mergedComponents: 0, mergedCells: 0 })
}

// 4. 边界上的碎斑同样归并（角落只有两票，也都是主配方）。
{
  const { ids, width, height } = grid([
    [8, 4, 4, 4],
    [4, 4, 4, 4],
    [4, 4, 4, 6],
  ])
  const stats = despeckleRecipeGrid(ids, width, height, 2)
  assert.deepEqual(rows(ids, width), [
    [4, 4, 4, 4],
    [4, 4, 4, 4],
    [4, 4, 4, 4],
  ])
  assert.deepEqual(stats, { mergedComponents: 2, mergedCells: 2 })
}

// 5. 阈值为 0 时完全不动（对照实验通道）。
{
  const { ids, width, height } = grid([[1, 9, 1]])
  const before = [...ids]
  const stats = despeckleRecipeGrid(ids, width, height, 0)
  assert.deepEqual([...ids], before)
  assert.deepEqual(stats, { mergedComponents: 0, mergedCells: 0 })
}

// 6. 大网格性能与正确性：2000×2000 背景撒 1000 个单格碎斑 + 一条细线。
{
  const width = 2000
  const height = 2000
  const ids = new Uint16Array(width * height).fill(1)
  // 固定步长撒 1000 个互不相邻的单格碎斑（x 间隔 19、y 间隔 199，且都远离细线行）。
  for (let k = 0; k < 1000; k++) ids[(2 + Math.floor(k / 100) * 199) * width + (2 + (k % 100) * 19)] = 9
  for (let x = 0; x < width; x++) ids[1000 * width + x] = 3 // 细线保留
  const started = performance.now()
  const stats = despeckleRecipeGrid(ids, width, height, 4)
  const ms = performance.now() - started
  assert.equal(stats.mergedComponents, 1000)
  assert.equal(stats.mergedCells, 1000)
  assert.ok(ids.every(value => value === 1 || value === 3), '碎斑必须全部归并，细线必须保留')
  assert.ok(ms < 20000, `4M 格清理必须在 20s 内完成，实际 ${(ms / 1000).toFixed(1)}s`)
  console.log(`  4M 格清理 ${stats.mergedCells} 格耗时 ${(ms / 1000).toFixed(2)}s`)
}

console.log('verify:native-despeckle OK')
