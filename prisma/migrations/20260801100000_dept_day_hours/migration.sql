-- CreateTable
CREATE TABLE "DeptDayHours" (
    "id" SERIAL NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "dept" TEXT NOT NULL,
    "hours" DOUBLE PRECISION NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeptDayHours_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DeptDayHours_date_dept_key" ON "DeptDayHours"("date", "dept");
