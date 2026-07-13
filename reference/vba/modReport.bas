Attribute VB_Name = "modReport"
Option Explicit
'============ modReport - Daily Report + PDF export ============
' Page 1: day summary + projects worked today
' Page 2: day charts + worked-today progress TABLE
' Page 3: all projects progress TABLE (like Plan Tracker)

Public Sub ShowDailyReport()
    Dim rp As Worksheet, orders As Worksheet, logS As Worksheet, lists As Worksheet
    On Error Resume Next
    Set rp = Sheets("Daily Report")
    On Error GoTo 0
    If rp Is Nothing Then MsgBox "Sheet 'Daily Report' not found.", vbExclamation: Exit Sub
    Set orders = Sheets("Plan Orders"): Set logS = Sheets("Daily Handover")
    Set lists = Sheets("Lists")
    Dim D As Variant: D = rp.Range("B2").Value
    If Not IsDateVal(D) Then MsgBox "Pick a day in B2.", vbExclamation: Exit Sub
    Dim Dt As Long: Dt = DOnly(D)
    Dim target As Double
    target = Nv(lists.Range("J5").Value)
    If target = 0 Then target = Nv(lists.Range("J4").Value)
    If target = 0 Then target = 27
    Dim IT As Variant: IT = ItemsArr()
    ' ---- read log ----
    Dim deptItem As Object, bomWeek As Object, weldCum As Object
    Set deptItem = NewDict(): Set bomWeek = NewDict(): Set weldCum = NewDict()
    Dim bomDept As Object: Set bomDept = NewDict()
    Dim lLast As Long: lLast = logS.Cells(logS.Rows.Count, 1).End(xlUp).Row
    Dim i As Long
    If lLast >= 2 Then
        Dim lV As Variant: lV = logS.Range("A2:F" & lLast).Value
        For i = 1 To UBound(lV, 1)
            If IsDateVal(lV(i, 1)) Then
                Dim dtl As Long: dtl = DOnly(lV(i, 1))
                If dtl <= Dt Then
                    Dim dp As String: dp = S(lV(i, 2))
                    Dim bm As String: bm = BomGroup(S(lV(i, 3)))
                    Dim itm As String: itm = S(lV(i, 4))
                    Dim q As Double: q = Nv(lV(i, 5))
                    If bm <> "" And itm <> "" And q > 0 Then
                        If dp = "Welding" Then DAdd weldCum, bm & "|" & itm, q
                        If dtl = Dt Then
                            DAdd deptItem, dp & "|" & itm, q
                            Dim bk As String: bk = bm & "|" & dp
                            If Not bomDept.Exists(bk) Then bomDept.Add bk, NewDict()
                            DAdd bomDept(bk), itm, q
                            If Not bomWeek.Exists(bm) Then bomWeek.Add bm, Nv(lV(i, 6))
                        End If
                    End If
                End If
            End If
        Next i
    End If
    ' ---- Plan Orders: required & targets per week|bom ----
    Dim reqD As Object, tgtD As Object, moSeen As Object, descOf As Object, bomWeeksAll As Object
    Set reqD = NewDict(): Set tgtD = NewDict(): Set moSeen = NewDict()
    Set descOf = NewDict(): Set bomWeeksAll = NewDict()
    Dim oLast As Long: oLast = orders.Cells(orders.Rows.Count, 1).End(xlUp).Row
    If oLast >= 2 Then
        Dim oV As Variant: oV = orders.Range("A2:J" & oLast).Value
        For i = 1 To UBound(oV, 1)
            Dim wk As Double: wk = Nv(oV(i, 1))
            Dim bomO As String: bomO = BomGroup(S(oV(i, 2)))
            Dim moO As String: moO = S(oV(i, 4))
            If wk <> 0 And bomO <> "" Then
                Dim mk As String: mk = wk & "|" & bomO & "|" & moO
                If Not moSeen.Exists(mk) Then
                    moSeen.Add mk, True
                    DAdd reqD, wk & "|" & bomO, Nv(oV(i, 7))
                End If
                DAdd tgtD, wk & "|" & bomO & "|" & S(oV(i, 6)), Nv(oV(i, 9))
                If S(oV(i, 5)) <> "" And Not descOf.Exists(bomO) Then descOf.Add bomO, oV(i, 5)
                If Not bomWeeksAll.Exists(bomO) Then bomWeeksAll.Add bomO, NewDict()
                bomWeeksAll(bomO)(CStr(wk)) = True
            End If
        Next i
    End If
    ' ---- section 1: department output ----
    Dim depts As Variant: depts = Array("Cut", "Welding")
    Dim deptRows(1 To 2, 1 To 10) As Variant
    Dim dTotal(0 To 1) As Double, dSets(0 To 1) As Double, dBal(0 To 1) As Double
    Dim dVals(0 To 1, 0 To 3) As Double
    Dim di As Long, ti As Long
    For di = 0 To 1
        Dim tot As Double: tot = 0
        For ti = 0 To 3
            dVals(di, ti) = DGet(deptItem, depts(di) & "|" & IT(ti))
            tot = tot + dVals(di, ti)
        Next ti
        Dim sets As Double
        sets = MinOf4(dVals(di, 0), dVals(di, 1), dVals(di, 2), dVals(di, 3))
        dTotal(di) = tot: dSets(di) = sets
        deptRows(di + 1, 1) = depts(di)
        For ti = 0 To 3
            deptRows(di + 1, 2 + ti) = dVals(di, ti)
        Next ti
        deptRows(di + 1, 6) = tot
        deptRows(di + 1, 7) = target
        deptRows(di + 1, 8) = sets
        deptRows(di + 1, 9) = tot / (4 * target)
        If tot > 0 Then
            dBal(di) = (sets * 4) / tot
            deptRows(di + 1, 10) = dBal(di)
        Else
            dBal(di) = -1
            deptRows(di + 1, 10) = ""
        End If
    Next di
    ' ---- section 2: projects worked today ----
    Dim pRows() As Variant: ReDim pRows(1 To bomDept.Count + 1, 1 To 12)
    Dim nP As Long: nP = 0
    Dim keysArr() As String, nK As Long: nK = bomDept.Count
    If nK > 0 Then
        ReDim keysArr(1 To nK)
        Dim kx As Variant, ki As Long: ki = 0
        For Each kx In bomDept.Keys
            ki = ki + 1: keysArr(ki) = CStr(kx)
        Next kx
        Dim a As Long, b2 As Long
        Dim tmpS As String
        For a = 1 To nK - 1
            For b2 = a + 1 To nK
                If keysArr(b2) < keysArr(a) Then
                    tmpS = keysArr(a): keysArr(a) = keysArr(b2): keysArr(b2) = tmpS
                End If
            Next b2
        Next a
        For ki = 1 To nK
            Dim parts() As String: parts = Split(keysArr(ki), "|")
            Dim bomK As String: bomK = parts(0)
            Dim depK As String: depK = parts(1)
            Dim m As Object: Set m = bomDept(keysArr(ki))
            Dim totT As Double: totT = 0
            Dim vals(0 To 3) As Double
            For ti = 0 To 3
                vals(ti) = DGet(m, CStr(IT(ti)))
                totT = totT + vals(ti)
            Next ti
            Dim wkB As Double: wkB = DGet(bomWeek, bomK)
            If DGet(reqD, wkB & "|" & bomK) = 0 And bomWeeksAll.Exists(bomK) Then
                Dim wkc As Variant
                For Each wkc In bomWeeksAll(bomK).Keys
                    If DGet(reqD, wkc & "|" & bomK) > 0 Then wkB = CDbl(wkc)
                Next wkc
            End If
            Dim RQ As Double: RQ = DGet(reqD, wkB & "|" & bomK)
            Dim completed As Double, haveC As Boolean: haveC = False
            For ti = 0 To 3
                Dim TT As Double: TT = DGet(tgtD, wkB & "|" & bomK & "|" & IT(ti))
                Dim pre As Double: pre = RQ - TT: If pre < 0 Then pre = 0
                Dim eff As Double: eff = pre + DGet(weldCum, bomK & "|" & IT(ti))
                If eff > RQ Then eff = RQ
                If Not haveC Then
                    completed = eff: haveC = True
                ElseIf eff < completed Then
                    completed = eff
                End If
            Next ti
            If Not haveC Then completed = 0
            nP = nP + 1
            pRows(nP, 1) = bomK
            If descOf.Exists(bomK) Then pRows(nP, 2) = descOf(bomK) Else pRows(nP, 2) = ""
            pRows(nP, 3) = depK
            For ti = 0 To 3
                pRows(nP, 4 + ti) = vals(ti)
            Next ti
            pRows(nP, 8) = totT
            If RQ > 0 Then
                pRows(nP, 9) = RQ: pRows(nP, 10) = completed
                pRows(nP, 11) = completed / RQ
                If completed >= RQ Then
                    pRows(nP, 12) = "Closed"
                Else
                    pRows(nP, 12) = "In progress"
                End If
            Else
                pRows(nP, 9) = "": pRows(nP, 10) = "": pRows(nP, 11) = ""
                pRows(nP, 12) = "No plan data"
            End If
        Next ki
    End If
    ' ---- write report ----
    Application.ScreenUpdating = False
    With rp.Range("A1:L1")
        .Interior.Color = RGB(31, 78, 121)
        .Font.Color = vbWhite: .Font.Bold = True: .Font.Size = 13
        .VerticalAlignment = xlCenter
    End With
    rp.Rows(1).RowHeight = 26
    rp.Range("D2").Value = "Pick the day in B2, then click Run Report"
    Dim wArr As Variant, cIdx As Long
    wArr = Array(13.5, 18.5, 8.5, 5.5, 5.5, 5.5, 10.5, 12.5, 13, 13.5, 10.5, 12)
    For cIdx = 0 To 11
        rp.Columns(cIdx + 1).ColumnWidth = wArr(cIdx)
    Next cIdx
    DeleteReportCharts rp
    rp.ResetAllPageBreaks
    With rp.Range("A4:L400")
        .FormatConditions.Delete
        .UnMerge
        .ClearContents
        .Interior.ColorIndex = xlNone
        .Font.Bold = False
        .Font.ColorIndex = xlAutomatic
        .Font.Size = 11
        .Borders.LineStyle = xlNone
        .WrapText = False
        .HorizontalAlignment = xlGeneral
        .VerticalAlignment = xlBottom
    End With
    rp.Rows("4:400").RowHeight = 15
    Dim rw As Long: rw = 4
    rp.Cells(rw, 1).Value = "DEPARTMENT OUTPUT TODAY - " & Format(D, "dd/mm/yyyy")
    rp.Cells(rw, 1).Font.Bold = True
    rp.Cells(rw, 1).Font.Color = RGB(31, 78, 121)
    rw = rw + 1
    Dim h1 As Variant
    h1 = Array("Dept", "CF", "TC", "TN", "CB", "Total", "Target/Item", "Complete Sets", "Efficiency %", "Balance %")
    rp.Cells(rw, 1).Resize(1, 10).Value = h1
    With rp.Cells(rw, 1).Resize(1, 10)
        .Interior.Color = RGB(31, 78, 121): .Font.Color = vbWhite: .Font.Bold = True
        .HorizontalAlignment = xlCenter
    End With
    rw = rw + 1
    rp.Cells(rw, 1).Resize(2, 10).Value = deptRows
    rp.Cells(rw, 9).Resize(2, 2).NumberFormat = "0%"
    With rp.Range(rp.Cells(rw - 1, 1), rp.Cells(rw + 1, 10)).Borders
        .LineStyle = xlContinuous: .Weight = xlThin: .Color = RGB(191, 191, 191)
    End With
    rp.Cells(rw, 2).Resize(2, 9).HorizontalAlignment = xlCenter
    rp.Cells(rw, 1).Resize(2, 1).Font.Bold = True
    rp.Cells(rw, 8).Resize(2, 1).Font.Bold = True
    For di = 0 To 1
        StyleThreshold rp.Cells(rw + di, 9), CDbl(deptRows(di + 1, 9)), 0.9, 0.5
        If dBal(di) >= 0 Then
            StyleThreshold rp.Cells(rw + di, 10), dBal(di), 1, 0.7
        End If
    Next di
    rw = rw + 3
    rp.Cells(rw, 1).Value = "PROJECTS WORKED TODAY"
    rp.Cells(rw, 1).Font.Bold = True
    rp.Cells(rw, 1).Font.Color = RGB(31, 78, 121)
    rw = rw + 1
    Dim h2 As Variant
    h2 = Array("BOM", "Description", "Dept", "CF", "TC", "TN", "CB", "Total Today", _
               "Required (units)", "Completed (units)", "Progress %", "Status")
    rp.Cells(rw, 1).Resize(1, 12).Value = h2
    With rp.Cells(rw, 1).Resize(1, 12)
        .Interior.Color = RGB(31, 78, 121): .Font.Color = vbWhite: .Font.Bold = True
        .HorizontalAlignment = xlCenter
    End With
    rw = rw + 1
    If nP > 0 Then
        rp.Cells(rw, 1).Resize(nP, 12).Value = pRows
        rp.Cells(rw, 11).Resize(nP, 1).NumberFormat = "0%"
        With rp.Range(rp.Cells(rw - 1, 1), rp.Cells(rw + nP - 1, 12)).Borders
            .LineStyle = xlContinuous: .Weight = xlThin: .Color = RGB(191, 191, 191)
        End With
        rp.Cells(rw, 3).Resize(nP, 9).HorizontalAlignment = xlCenter
        rp.Cells(rw, 8).Resize(nP, 1).Font.Bold = True
        For i = 1 To nP
            If i Mod 2 = 0 Then
                rp.Cells(rw + i - 1, 1).Resize(1, 12).Interior.Color = RGB(242, 247, 251)
            End If
        Next i
        For i = 1 To nP
            With rp.Cells(rw + i - 1, 12)
                .Font.Bold = True: .HorizontalAlignment = xlCenter
                Select Case pRows(i, 12)
                    Case "Closed"
                        .Interior.Color = RGB(217, 234, 211): .Font.Color = RGB(56, 118, 29)
                    Case "In progress"
                        .Interior.Color = RGB(255, 242, 204): .Font.Color = RGB(127, 96, 0)
                    Case "No plan data"
                        .Interior.Color = RGB(244, 204, 204): .Font.Color = RGB(153, 0, 0)
                End Select
            End With
        Next i
        Dim db As Databar
        Set db = rp.Range(rp.Cells(rw, 11), rp.Cells(rw + nP - 1, 11)).FormatConditions.AddDatabar
        db.MinPoint.Modify newtype:=xlConditionValueNumber, newvalue:=0
        db.MaxPoint.Modify newtype:=xlConditionValueNumber, newvalue:=1
        db.BarColor.Color = RGB(46, 117, 182)
        rw = rw + nP
    End If
    Application.ScreenUpdating = True
End Sub

Private Sub StyleThreshold(c As Range, v As Double, hi As Double, mid As Double)
    c.Font.Bold = True
    c.HorizontalAlignment = xlCenter
    If v >= hi Then
        c.Interior.Color = RGB(217, 234, 211): c.Font.Color = RGB(56, 118, 29)
    ElseIf v >= mid Then
        c.Interior.Color = RGB(255, 242, 204): c.Font.Color = RGB(127, 96, 0)
    Else
        c.Interior.Color = RGB(244, 204, 204): c.Font.Color = RGB(153, 0, 0)
    End If
End Sub

Public Sub ExportDailyReportPDF()
    Dim rp As Worksheet
    On Error Resume Next
    Set rp = Sheets("Daily Report")
    On Error GoTo 0
    If rp Is Nothing Then MsgBox "Sheet 'Daily Report' not found.", vbExclamation: Exit Sub
    Dim D As Variant: D = rp.Range("B2").Value
    If Not IsDateVal(D) Then MsgBox "Pick a day in B2 first.", vbExclamation: Exit Sub
    ShowDailyReport
    Application.ScreenUpdating = False
    Dim lastPrint As Long
    lastPrint = BuildReportPages(rp, D)
    With rp.PageSetup
        .PrintArea = "$A$1:$L$" & lastPrint
        .Orientation = xlLandscape
        .PaperSize = xlPaperA4
        .Zoom = False
        .FitToPagesWide = 1
        .FitToPagesTall = False
        .LeftMargin = Application.InchesToPoints(0.3)
        .RightMargin = Application.InchesToPoints(0.3)
        .TopMargin = Application.InchesToPoints(0.4)
        .BottomMargin = Application.InchesToPoints(0.4)
        .HeaderMargin = Application.InchesToPoints(0.2)
        .FooterMargin = Application.InchesToPoints(0.2)
        .CenterHorizontally = True
        .CenterFooter = "Page &P / &N"
    End With
    Dim fld As String: fld = ThisWorkbook.Path
    If fld = "" Then fld = Environ$("USERPROFILE") & "\Desktop"
    Dim fName As String
    fName = fld & Application.PathSeparator & "Daily Report " & Format(D, "yyyy-mm-dd") & ".pdf"
    On Error GoTo failed
    rp.ExportAsFixedFormat Type:=xlTypePDF, Filename:=fName, _
        Quality:=xlQualityStandard, IncludeDocProperties:=True, _
        IgnorePrintAreas:=False, OpenAfterPublish:=True
    Application.ScreenUpdating = True
    MsgBox "PDF saved:" & vbCrLf & fName, vbInformation
    Exit Sub
failed:
    Application.ScreenUpdating = True
    MsgBox "Could not save the PDF (is a previous PDF still open?)." & vbCrLf & _
           Err.Description, vbExclamation
End Sub

' builds page 2 (charts + worked-today table) and page 3 (all projects table)
Private Function BuildReportPages(rp As Worksheet, D As Variant) As Long
    DeleteReportCharts rp
    Dim nP As Long, r As Long
    r = 11
    Do While S(rp.Cells(r, 1).Value) <> ""
        r = r + 1
    Loop
    nP = r - 11
    Dim lastRow As Long: lastRow = rp.Cells(rp.Rows.Count, 1).End(xlUp).Row
    Dim L0 As Double: L0 = rp.Range("A1").Left
    Dim wFull As Double: wFull = rp.Range("A1:L1").Width
    Dim half As Double: half = wFull / 2 - 5
    Dim co As ChartObject, ch As Chart, sr As Series
    ' ================= PAGE 2 : DAY CHARTS + WORKED-TODAY TABLE =================
    Dim hdr2 As Long: hdr2 = lastRow + 2
    PageHeader rp, hdr2, "DAY CHARTS - " & Format(D, "dd/mm/yyyy")
    rp.HPageBreaks.Add Before:=rp.Rows(hdr2)
    Dim T0 As Double: T0 = rp.Cells(hdr2 + 1, 1).Top + 4
    Set co = rp.ChartObjects.Add(L0, T0, half, 220)
    co.Name = "rpt_output"
    Set ch = co.Chart
    ch.ChartType = xlColumnClustered
    Set sr = ch.SeriesCollection.NewSeries
    sr.Name = "Cut": sr.Values = rp.Range("B6:E6"): sr.XValues = rp.Range("B5:E5")
    sr.Format.Fill.ForeColor.RGB = RGB(112, 173, 71)
    sr.HasDataLabels = True
    Set sr = ch.SeriesCollection.NewSeries
    sr.Name = "Welding": sr.Values = rp.Range("B7:E7"): sr.XValues = rp.Range("B5:E5")
    sr.Format.Fill.ForeColor.RGB = RGB(46, 117, 182)
    sr.HasDataLabels = True
    ch.HasTitle = True
    ch.ChartTitle.Text = "Output by Component - " & Format(D, "dd/mm/yyyy")
    ch.ChartTitle.Font.Size = 11: ch.ChartTitle.Font.Bold = True
    ch.HasLegend = True: ch.Legend.Position = xlLegendPositionBottom
    ch.ChartArea.Format.Line.Visible = msoFalse
    Set co = rp.ChartObjects.Add(L0 + half + 10, T0, half, 220)
    co.Name = "rpt_sets"
    Set ch = co.Chart
    ch.ChartType = xlColumnClustered
    Set sr = ch.SeriesCollection.NewSeries
    sr.Name = "Target / Item": sr.Values = rp.Range("G6:G7"): sr.XValues = rp.Range("A6:A7")
    sr.Format.Fill.ForeColor.RGB = RGB(166, 166, 166)
    sr.HasDataLabels = True
    Set sr = ch.SeriesCollection.NewSeries
    sr.Name = "Complete Sets": sr.Values = rp.Range("H6:H7"): sr.XValues = rp.Range("A6:A7")
    sr.Format.Fill.ForeColor.RGB = RGB(31, 78, 121)
    sr.HasDataLabels = True
    ch.HasTitle = True
    ch.ChartTitle.Text = "Complete Sets vs Daily Target"
    ch.ChartTitle.Font.Size = 11: ch.ChartTitle.Font.Bold = True
    ch.HasLegend = True: ch.Legend.Position = xlLegendPositionBottom
    ch.ChartArea.Format.Line.Visible = msoFalse
    ' first row below the two charts
    Dim rowBelow As Long: rowBelow = hdr2 + 1
    Do While rp.Cells(rowBelow, 1).Top < T0 + 240
        rowBelow = rowBelow + 1
    Loop
    BuildReportPages = rowBelow
    ' ---- worked-today progress table ----
    Dim tr As Worksheet
    On Error Resume Next
    Set tr = Sheets("Plan Tracker")
    On Error GoTo 0
    If tr Is Nothing Then Exit Function
    Dim wt As Object: Set wt = NewDict()
    For r = 11 To 10 + nP
        If S(rp.Cells(r, 1).Value) <> "" Then wt(S(rp.Cells(r, 1).Value)) = True
    Next r
    Dim endP2 As Long
    endP2 = WriteTrackerTable(rp, tr, rowBelow, "PROJECTS WORKED TODAY - PROGRESS", wt)
    If endP2 >= rowBelow Then BuildReportPages = endP2
    ' ================= PAGE 3 : ALL PROJECTS TABLE =================
    Dim hdr3 As Long: hdr3 = BuildReportPages + 2
    Dim endP3 As Long
    endP3 = WriteTrackerTable(rp, tr, hdr3, "ALL PROJECTS - PLAN TRACKER (Plan " & S(tr.Range("B2").Value) & ")", Nothing)
    If endP3 >= hdr3 Then
        rp.HPageBreaks.Add Before:=rp.Rows(hdr3)
        BuildReportPages = endP3
    End If
End Function

' writes a tracker-style table; filter = dict of BOM codes, or Nothing = all rows
Private Function WriteTrackerTable(rp As Worksheet, tr As Worksheet, startRow As Long, title As String, filter As Object) As Long
    WriteTrackerTable = startRow - 1
    Dim trLast As Long: trLast = tr.Cells(tr.Rows.Count, 1).End(xlUp).Row
    If trLast < 5 Then Exit Function
    Dim rw As Long: rw = startRow
    PageHeader rp, rw, title
    rw = rw + 1
    Dim h As Variant
    h = Array("BOM", "Required", "CF Cut", "CF Weld", "TC Cut", "TC Weld", _
              "TN Cut", "TN Weld", "CB Cut", "CB Weld", "Completed", "Progress %")
    rp.Cells(rw, 1).Resize(1, 12).Value = h
    With rp.Cells(rw, 1).Resize(1, 12)
        .Interior.Color = RGB(31, 78, 121): .Font.Color = vbWhite: .Font.Bold = True
        .HorizontalAlignment = xlCenter: .Font.Size = 10
    End With
    rw = rw + 1
    Dim firstData As Long: firstData = rw
    Dim r As Long, n As Long: n = 0
    For r = 5 To trLast
        Dim bomT As String: bomT = S(tr.Cells(r, 1).Value)
        If bomT <> "" Then
            Dim keep As Boolean: keep = True
            If Not filter Is Nothing Then keep = filter.Exists(bomT)
            If keep Then
                rp.Cells(rw, 1).Value = bomT
                rp.Cells(rw, 2).Value = tr.Cells(r, 4).Value
                Dim cIdx As Long
                For cIdx = 0 To 7
                    rp.Cells(rw, 3 + cIdx).Value = tr.Cells(r, 5 + cIdx).Value
                Next cIdx
                rp.Cells(rw, 11).Value = tr.Cells(r, 13).Value
                rp.Cells(rw, 12).Value = tr.Cells(r, 15).Value
                n = n + 1: rw = rw + 1
            End If
        End If
    Next r
    If n = 0 Then
        rp.Cells(firstData, 1).Value = "No data"
        WriteTrackerTable = firstData
        Exit Function
    End If
    Dim body As Range
    Set body = rp.Range(rp.Cells(firstData, 1), rp.Cells(rw - 1, 12))
    body.HorizontalAlignment = xlCenter
    body.Font.Size = 10
    With body.Borders
        .LineStyle = xlContinuous: .Weight = xlThin: .Color = RGB(191, 191, 191)
    End With
    Dim rr As Long
    For rr = firstData + 1 To rw - 1 Step 2
        rp.Cells(rr, 1).Resize(1, 2).Interior.Color = RGB(242, 247, 251)
        rp.Cells(rr, 11).Resize(1, 1).Interior.Color = RGB(242, 247, 251)
    Next rr
    For rr = 0 To 3
        rp.Range(rp.Cells(firstData, 3 + 2 * rr), rp.Cells(rw - 1, 3 + 2 * rr)).Interior.Color = RGB(226, 239, 218)
        rp.Range(rp.Cells(firstData, 4 + 2 * rr), rp.Cells(rw - 1, 4 + 2 * rr)).Interior.Color = RGB(221, 235, 247)
    Next rr
    rp.Range(rp.Cells(firstData, 12), rp.Cells(rw - 1, 12)).NumberFormat = "0.0%"
    rp.Range(rp.Cells(firstData, 11), rp.Cells(rw - 1, 11)).Font.Bold = True
    Dim cs As ColorScale
    Set cs = rp.Range(rp.Cells(firstData, 12), rp.Cells(rw - 1, 12)).FormatConditions.AddColorScale(ColorScaleType:=3)
    With cs.ColorScaleCriteria(1)
        .Type = xlConditionValueNumber: .Value = 0
        .FormatColor.Color = RGB(244, 183, 176)
    End With
    With cs.ColorScaleCriteria(2)
        .Type = xlConditionValueNumber: .Value = 0.5
        .FormatColor.Color = RGB(252, 228, 166)
    End With
    With cs.ColorScaleCriteria(3)
        .Type = xlConditionValueNumber: .Value = 1
        .FormatColor.Color = RGB(169, 211, 160)
    End With
    WriteTrackerTable = rw - 1
End Function

Private Sub DeleteReportCharts(ws As Worksheet)
    Dim i As Long
    For i = ws.ChartObjects.Count To 1 Step -1
        If Left$(ws.ChartObjects(i).Name, 4) = "rpt_" Then ws.ChartObjects(i).Delete
    Next i
    ws.Range("N1:Q400").ClearContents
End Sub

Private Sub PageHeader(ws As Worksheet, r As Long, txt As String)
    With ws.Range(ws.Cells(r, 1), ws.Cells(r, 12))
        .Interior.Color = RGB(31, 78, 121)
        .Font.Color = vbWhite: .Font.Bold = True: .Font.Size = 12
        .VerticalAlignment = xlCenter
    End With
    ws.Cells(r, 1).Value = txt
    ws.Rows(r).RowHeight = 22
End Sub

