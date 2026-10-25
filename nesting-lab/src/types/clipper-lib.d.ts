declare module "clipper-lib" {
  export interface IntPoint {
    X: number;
    Y: number;
  }
  export type Path = IntPoint[];
  export type Paths = Path[];
  export const Paths: { new (): Paths };
  export const Path: { new (): Path };
  export enum ClipType {
    ctIntersection = 0,
    ctUnion = 1,
    ctDifference = 2,
    ctXor = 3,
  }
  export enum PolyType {
    ptSubject = 0,
    ptClip = 1,
  }
  export enum PolyFillType {
    pftEvenOdd = 0,
    pftNonZero = 1,
    pftPositive = 2,
    pftNegative = 3,
  }
  export enum JoinType {
    jtSquare = 0,
    jtRound = 1,
    jtMiter = 2,
  }
  export enum EndType {
    etOpenSquare = 0,
    etOpenRound = 1,
    etOpenButt = 2,
    etClosedLine = 3,
    etClosedPolygon = 4,
  }
  export class Clipper {
    constructor(initOptions?: number);
    AddPath(path: Path, polyType: PolyType, closed: boolean): boolean;
    AddPaths(paths: Paths, polyType: PolyType, closed: boolean): boolean;
    Execute(clipType: ClipType, solution: Paths, subjFillType?: PolyFillType, clipFillType?: PolyFillType): boolean;
    Clear(): void;
    static MinkowskiSum(pattern: Path, path: Path, pathIsClosed: boolean): Paths;
    static Area(path: Path): number;
    static Orientation(path: Path): boolean;
    static PointInPolygon(pt: IntPoint, path: Path): number;
    static SimplifyPolygons(polys: Paths, fillType?: PolyFillType): Paths;
    static CleanPolygons(polys: Paths, distance?: number): Paths;
    static ReversePaths(paths: Paths): void;
  }
  export class ClipperOffset {
    constructor(miterLimit?: number, arcTolerance?: number);
    AddPath(path: Path, joinType: JoinType, endType: EndType): void;
    AddPaths(paths: Paths, joinType: JoinType, endType: EndType): void;
    Execute(solution: Paths, delta: number): void;
    Clear(): void;
  }
  const ClipperLib: {
    Clipper: typeof Clipper;
    ClipperOffset: typeof ClipperOffset;
    ClipType: typeof ClipType;
    PolyType: typeof PolyType;
    PolyFillType: typeof PolyFillType;
    JoinType: typeof JoinType;
    EndType: typeof EndType;
    Paths: typeof Paths;
    Path: typeof Path;
  };
  export default ClipperLib;
}
