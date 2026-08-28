declare module 'polygon-clipping' {
  export type Pair = [number, number]
  export type Ring = Pair[]
  export type Polygon = Ring[]
  export type MultiPolygon = Polygon[]
  type Geom = Polygon | MultiPolygon

  const polygonClipping: {
    intersection(geom: Geom, ...geoms: Geom[]): MultiPolygon
    xor(geom: Geom, ...geoms: Geom[]): MultiPolygon
    union(geom: Geom, ...geoms: Geom[]): MultiPolygon
    difference(subjectGeom: Geom, ...clipGeoms: Geom[]): MultiPolygon
  }
  export default polygonClipping
}
