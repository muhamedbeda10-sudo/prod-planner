-- The Floor canvas: one drawn layout per department.

CREATE TABLE "FloorLayout" (
    "id" SERIAL NOT NULL,
    "dept" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "updatedBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "FloorLayout_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "FloorLayout_dept_key" ON "FloorLayout"("dept");
