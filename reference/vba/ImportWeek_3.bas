Attribute VB_Name = "ImportWeek"
Option Explicit

' ==============================================================
'  PRODUCTION MASTER v2
'  Macros:  ImportNewWeek   - import a new weekly plan
'           RefreshWorklist - rebuild the Daily Worklist
'  Plan dates are OVEN LOADING dates. Due date per process =
'  oven date - lead days (Settings B6:B7).
' ==============================================================

Const GRID_FIRST As Long = 6
Const GRID_LAST As Long = 105
Const TARGET_ROW As Long = 108
Const DAYS As Long = 6
Const ORD_MAX As Long = 800
Const HP_MAX As Long = 300
Const WL_HDR As Long = 5

' ==================== IMPORT ====================
Public Sub ImportNewWeek()
    Dim wsImp As Worksheet, wsCW As Worksheet, wsPH As Worksheet
    Dim wsOD As Worksheet, wsHP As Worksheet, wsST As Worksheet, wsRC As Worksheet
    Set wsImp = ThisWorkbook.Sheets("Import")
    Set wsCW = ThisWorkbook.Sheets("Current Week")
    Set wsPH = ThisWorkbook.Sheets("Plan History")
    Set wsOD = ThisWorkbook.Sheets("Orders")
    Set wsHP = ThisWorkbook.Sheets("Helper")
    Set wsST = ThisWorkbook.Sheets("Settings")
    Set wsRC = ThisWorkbook.Sheets("Reconciliation")

    If Trim(wsImp.Range("C6").Value & "") = "" Then
        MsgBox "Nothing to import: paste the new plan at Import!A1 first (data must start at row 6).", vbExclamation
        Exit Sub
    End If
    Dim newWk As Variant
    newWk = wsImp.Range("AG1").Value
    If Not IsNumeric(newWk) Or newWk = "" Then
        MsgBox "Type the new week number in Import!AG1.", vbExclamation
        Exit Sub
    End If
    newWk = CLng(newWk)
    Dim newStart As Variant
    newStart = wsImp.Range("AG2").Value
    If Not IsDate(newStart) Then
        MsgBox "Type the REAL week start date in Import!AG2." & vbCrLf & _
               "(Never trust the dates inside the plan - Planning copies them from old sheets.)", vbExclamation
        Exit Sub
    End If
    newStart = CDate(newStart)

    Dim lastData As Long, tgtRow As Long
    lastData = FindLastDataRow(wsImp)
    tgtRow = FindTargetRow(wsImp, lastData)
    If lastData - GRID_FIRST + 1 > (GRID_LAST - GRID_FIRST + 1) Then
        MsgBox "The new plan has more than 100 orders - ask Beda to extend the template.", vbCritical
        Exit Sub
    End If

    Application.ScreenUpdating = False
    Application.Calculation = xlCalculationManual

    Dim archived As Long
    archived = ArchiveCurrentWeek(wsCW, wsPH, wsST)
    LoadIntoCurrentWeek wsImp, wsCW, lastData, tgtRow, CDate(newStart)
    Dim nNew As Long, nUpd As Long
    UpsertOrders wsImp, wsOD, wsHP, lastData, CLng(newWk), nNew, nUpd

    wsST.Range("B2").Value = newStart
    wsST.Range("B3").Value = newWk
    On Error Resume Next
    ThisWorkbook.Sheets("Dashboard").Range("B3").Value = newStart
    ThisWorkbook.Sheets("Daily Worklist").Range("B2").Value = newStart
    On Error GoTo 0

    Application.Calculation = xlCalculationAutomatic
    Application.Calculate

    Dim nMis As Long
    nMis = BuildReconciliation(wsOD, wsRC, CLng(newWk))
    wsImp.Range("A1:AD500").ClearContents
    wsImp.Range("AG1:AG2").ClearContents

    RefreshWorklist

    Application.ScreenUpdating = True
    MsgBox "Week " & newWk & " imported successfully." & vbCrLf & _
           "- Archived plan rows from previous week: " & archived & vbCrLf & _
           "- Orders: " & nNew & " new, " & nUpd & " updated" & vbCrLf & _
           "- Reconciliation mismatches: " & nMis & " (see Reconciliation sheet)" & vbCrLf & vbCrLf & _
           "Now distribute the undistributed backlog rows over the days in Current Week, then run RefreshWorklist.", vbInformation
End Sub

' ==================== DAILY WORKLIST ====================
Public Sub RefreshWorklist()
    Dim wsWL As Worksheet, wsST As Worksheet, wsOD As Worksheet
    Dim wsPH As Worksheet, wsCW As Worksheet, wsLG As Worksheet
    Set wsWL = ThisWorkbook.Sheets("Daily Worklist")
    Set wsST = ThisWorkbook.Sheets("Settings")
    Set wsOD = ThisWorkbook.Sheets("Orders")
    Set wsPH = ThisWorkbook.Sheets("Plan History")
    Set wsCW = ThisWorkbook.Sheets("Current Week")
    Set wsLG = ThisWorkbook.Sheets("Production Log")

    Dim D As Date
    If IsDate(wsWL.Range("B2").Value) Then
        D = CDate(wsWL.Range("B2").Value)
    Else
        D = Date
        wsWL.Range("B2").Value = D
    End If
    Dim golive As Date, wkStart As Date
    golive = CDate(wsST.Range("B4").Value)
    wkStart = CDate(wsST.Range("B2").Value)
    Dim leads(1 To 2) As Long
    leads(1) = CLng(wsST.Range("B6").Value)  ' Cut
    leads(2) = CLng(wsST.Range("B7").Value)  ' Welding

    Application.ScreenUpdating = False
    AllocateMultiMO True
    Application.Calculate
    Dim planned(1 To 2) As Object, donePrev(1 To 2) As Object, doneToday(1 To 2) As Object
    Dim p As Long
    For p = 1 To 2
        Set planned(p) = CreateObject("Scripting.Dictionary")
        Set donePrev(p) = CreateObject("Scripting.Dictionary")
        Set doneToday(p) = CreateObject("Scripting.Dictionary")
    Next p

    ' ---- planned due per process: oven date in [golive+lead, D+lead] ----
    Dim itemsArr As Variant
    itemsArr = Array("CF", "TC", "TN", "CB")
    Dim r As Long, key As String, ov As Variant, q As Variant
    Dim phLast As Long
    phLast = wsPH.Cells(wsPH.Rows.Count, 2).End(xlUp).Row
    Dim phV As Variant
    If phLast >= 2 Then
        phV = wsPH.Range("A2:F" & phLast).Value
        For r = 1 To UBound(phV, 1)
            If IsDate(phV(r, 5)) Then
                ov = CDate(phV(r, 5))
                key = Trim(phV(r, 2)) & "|" & Trim(phV(r, 4))
                q = phV(r, 6)
                If IsNumeric(q) Then
                    For p = 1 To 2
                        If ov >= golive And ov <= D + leads(p) Then
                            planned(p)(key) = Nz(planned(p), key) + q
                        End If
                    Next p
                End If
            End If
        Next r
    End If
    Dim g As Long, k As Long, mo As String
    For r = GRID_FIRST To GRID_LAST
        mo = Trim(wsCW.Cells(r, 3).Value & "")
        If mo <> "" Then
            For g = 0 To DAYS - 1
                ov = wkStart + g
                For k = 0 To 3
                    q = wsCW.Cells(r, 6 + 4 * g + k).Value
                    If IsNumeric(q) And q <> "" Then
                        If q > 0 Then
                            key = mo & "|" & itemsArr(k)
                            For p = 1 To 2
                                If CDate(ov) >= golive And CDate(ov) <= D + leads(p) Then
                                    planned(p)(key) = Nz(planned(p), key) + q
                                End If
                            Next p
                        End If
                    End If
                Next k
            Next g
        End If
    Next r

    ' ---- done per process from the log (resolved MO) ----
    Dim lgLast As Long, lgV As Variant, unresolved As Long
    lgLast = wsLG.Cells(wsLG.Rows.Count, 1).End(xlUp).Row
    If lgLast >= 2 Then
        lgV = wsLG.Range("A2:K" & lgLast).Value
        For r = 1 To UBound(lgV, 1)
            If IsDate(lgV(r, 1)) And Trim(lgV(r, 9) & "") <> "" And IsNumeric(lgV(r, 6)) Then
                key = Trim(lgV(r, 9)) & "|" & Trim(lgV(r, 5))
                Select Case Trim(lgV(r, 2) & "")
                    Case "Cut": p = 1
                    Case "Welding": p = 2
                    Case Else: p = 0
                End Select
                If p > 0 Then
                    If CDate(lgV(r, 1)) < D Then
                        donePrev(p)(key) = Nz(donePrev(p), key) + lgV(r, 6)
                    ElseIf CDate(lgV(r, 1)) = D Then
                        doneToday(p)(key) = Nz(doneToday(p), key) + lgV(r, 6)
                    End If
                End If
            End If
            If IsDate(lgV(r, 1)) Then
                If CDate(lgV(r, 1)) = D And Trim(lgV(r, 11) & "") <> "" Then unresolved = unresolved + 1
            End If
        Next r
    End If

    ' ---- output ----
    wsWL.Range("A" & WL_HDR + 1 & ":J" & WL_HDR + ORD_MAX + 50).ClearContents
    wsWL.Range("A3").Value = "Unresolved log entries on this day (fix in Production Log): " & unresolved

    Dim outArr() As Variant
    ReDim outArr(1 To ORD_MAX, 1 To 10)
    Dim w As Long: w = 0
    Dim due(1 To 2) As Double, still(1 To 2) As Double, dt(1 To 2) As Double
    Dim sysRem As Variant, plannedWk As Variant, unsched As Variant, stat As String
    For r = 2 To ORD_MAX
        mo = Trim(wsOD.Cells(r, 1).Value & "")
        If mo = "" Then Exit For
        key = mo & "|" & Trim(wsOD.Cells(r, 4).Value & "")
        sysRem = wsOD.Cells(r, 11).Value
        plannedWk = wsOD.Cells(r, 13).Value
        For p = 1 To 2
            Dim pl As Double, dp As Double
            pl = Nz(planned(p), key): dp = Nz(donePrev(p), key)
            dt(p) = Nz(doneToday(p), key)
            due(p) = pl - dp: If due(p) < 0 Then due(p) = 0
            still(p) = pl - dp - dt(p): If still(p) < 0 Then still(p) = 0
        Next p
        ' STRICT rule: show only rows with something DUE on this day
        ' (due = planned for today + overdue from previous days)
        If due(1) > 0 Or due(2) > 0 Then
            If due(2) > 0 Then
                If still(2) = 0 Then
                    stat = "Done"
                ElseIf dt(2) > 0 Then
                    stat = "In progress"
                Else
                    stat = "Pending"
                End If
            Else
                stat = "Cut due"
            End If
            w = w + 1
            outArr(w, 1) = mo
            outArr(w, 2) = wsOD.Cells(r, 2).Value
            outArr(w, 3) = wsOD.Cells(r, 4).Value
            outArr(w, 4) = due(1): outArr(w, 5) = dt(1): outArr(w, 6) = still(1)
            outArr(w, 7) = due(2): outArr(w, 8) = dt(2): outArr(w, 9) = still(2)
            outArr(w, 10) = stat
        End If
    Next r
    If w > 0 Then
        wsWL.Range("A" & WL_HDR + 1).Resize(w, 10).Value = outArr
    End If
    Application.ScreenUpdating = True
End Sub

Private Function Nz(d As Object, key As String) As Double
    If d.Exists(key) Then Nz = CDbl(d(key)) Else Nz = 0
End Function

' ==================== AUTO-SPLIT multi-MO BOM log entries ====================
' Splits any log row that has a multi-MO BOM and no MO across that BOM's
' MOs automatically: FIFO by plan order, each MO takes up to its remaining
' need for that process (Opening Balance - already-attributed output).
' Any excess goes to the last MO. Runs automatically inside RefreshWorklist.
Public Sub AllocateMultiMO(Optional quiet As Boolean = False)
    Dim wsLG As Worksheet, wsOD As Worksheet, wsHP As Worksheet
    Set wsLG = ThisWorkbook.Sheets("Production Log")
    Set wsOD = ThisWorkbook.Sheets("Orders")
    Set wsHP = ThisWorkbook.Sheets("Helper")

    ' BOM -> ordered MO list (plan order) + opening balances per MO|item
    Dim bomMOs As Object, opening As Object
    Set bomMOs = CreateObject("Scripting.Dictionary")
    Set opening = CreateObject("Scripting.Dictionary")
    Dim r As Long, mo As String, bom As String, it As String
    For r = 2 To ORD_MAX
        mo = Trim(wsOD.Cells(r, 1).Value & "")
        If mo = "" Then Exit For
        bom = Trim(wsOD.Cells(r, 2).Value & "")
        it = Trim(wsOD.Cells(r, 4).Value & "")
        opening(mo & "|" & it) = Val(wsOD.Cells(r, 6).Value & "")
        If it = "CF" Then
            If bomMOs.Exists(bom) Then
                bomMOs(bom) = bomMOs(bom) & ";" & mo
            Else
                bomMOs(bom) = mo
            End If
        End If
    Next r

    ' already-attributed output per process|mo|item (from resolved rows)
    Dim doneD As Object
    Set doneD = CreateObject("Scripting.Dictionary")
    Dim lgLast As Long
    lgLast = wsLG.Cells(wsLG.Rows.Count, 1).End(xlUp).Row
    Application.Calculate
    Dim k As String, q As Variant
    For r = 2 To lgLast
        If Trim(wsLG.Cells(r, 9).Value & "") <> "" And IsNumeric(wsLG.Cells(r, 6).Value) Then
            k = Trim(wsLG.Cells(r, 2).Value & "") & "|" & Trim(wsLG.Cells(r, 9).Value & "") & "|" & Trim(wsLG.Cells(r, 5).Value & "")
            If doneD.Exists(k) Then doneD(k) = doneD(k) + wsLG.Cells(r, 6).Value Else doneD(k) = wsLG.Cells(r, 6).Value
        End If
    Next r

    Dim appendAt As Long
    appendAt = lgLast + 1
    Dim nSplit As Long, nRows As Long
    Dim proc As String, qty As Double, mos As Variant, i As Long
    Dim need As Double, alloc As Double, firstDone As Boolean
    For r = 2 To lgLast
        bom = Trim(wsLG.Cells(r, 3).Value & "")
        If bom <> "" And Trim(wsLG.Cells(r, 4).Value & "") = "" And bomMOs.Exists(bom) Then
            mos = Split(bomMOs(bom), ";")
            If UBound(mos) >= 1 Then          ' multi-MO only
                proc = Trim(wsLG.Cells(r, 2).Value & "")
                it = Trim(wsLG.Cells(r, 5).Value & "")
                qty = Val(wsLG.Cells(r, 6).Value & "")
                If qty > 0 And (proc = "Cut" Or proc = "Welding") Then
                    firstDone = False
                    For i = 0 To UBound(mos)
                        k = proc & "|" & mos(i) & "|" & it
                        need = 0
                        If opening.Exists(mos(i) & "|" & it) Then need = opening(mos(i) & "|" & it)
                        If doneD.Exists(k) Then need = need - doneD(k)
                        If need < 0 Then need = 0
                        If i = UBound(mos) Then
                            alloc = qty                    ' الفائض كله على آخر أمر
                        Else
                            alloc = qty: If alloc > need Then alloc = need
                        End If
                        If alloc > 0 Then
                            If Not firstDone Then
                                wsLG.Cells(r, 4).Value = mos(i)
                                wsLG.Cells(r, 6).Value = alloc
                                wsLG.Cells(r, 8).Value = Trim(wsLG.Cells(r, 8).Value & " ") & "[auto-split]"
                                firstDone = True
                            Else
                                wsLG.Cells(appendAt, 1).Value = wsLG.Cells(r, 1).Value
                                wsLG.Cells(appendAt, 2).Value = proc
                                wsLG.Cells(appendAt, 3).Value = bom
                                wsLG.Cells(appendAt, 4).Value = mos(i)
                                wsLG.Cells(appendAt, 5).Value = it
                                wsLG.Cells(appendAt, 6).Value = alloc
                                wsLG.Cells(appendAt, 7).Value = wsLG.Cells(r, 7).Value
                                wsLG.Cells(appendAt, 8).Value = "[auto-split from row " & r & "]"
                                appendAt = appendAt + 1
                                nRows = nRows + 1
                            End If
                            If doneD.Exists(k) Then doneD(k) = doneD(k) + alloc Else doneD(k) = alloc
                            qty = qty - alloc
                        End If
                        If qty <= 0 Then Exit For
                    Next i
                    If firstDone Then nSplit = nSplit + 1
                End If
            End If
        End If
    Next r
    If nSplit > 0 Then Application.Calculate
    If Not quiet Then
        MsgBox "Auto-split done: " & nSplit & " log entries allocated across MOs (" & nRows & " extra rows added).", vbInformation
    End If
End Sub

' ==================== shared helpers ====================
Private Function FindLastDataRow(ws As Worksheet) As Long
    Dim r As Long, last As Long
    For r = GRID_FIRST To 500
        If Trim(ws.Cells(r, 3).Value & "") <> "" Then last = r
    Next r
    FindLastDataRow = last
End Function

Private Function FindTargetRow(ws As Worksheet, lastData As Long) As Long
    Dim r As Long, c As Long
    For r = lastData + 1 To lastData + 20
        For c = 5 To 29
            If IsNumeric(ws.Cells(r, c).Value) And ws.Cells(r, c).Value <> "" Then
                FindTargetRow = r
                Exit Function
            End If
        Next c
    Next r
    FindTargetRow = 0
End Function

Private Function ArchiveCurrentWeek(wsCW As Worksheet, wsPH As Worksheet, wsST As Worksheet) As Long
    Dim wkNo As Variant, wkStart As Variant
    wkNo = wsST.Range("B3").Value
    wkStart = wsST.Range("B2").Value
    If Not IsDate(wkStart) Then Exit Function
    Dim phNext As Long
    phNext = wsPH.Cells(wsPH.Rows.Count, 2).End(xlUp).Row + 1
    If phNext < 2 Then phNext = 2
    Dim r As Long, g As Long, k As Long, q As Variant
    Dim bom As String, cnt As Long
    For r = GRID_FIRST To GRID_LAST
        If Trim(wsCW.Cells(r, 3).Value & "") <> "" Then
            If Trim(wsCW.Cells(r, 1).Value & "") <> "" Then bom = Trim(wsCW.Cells(r, 1).Value & "")
            For g = 0 To DAYS - 1
                For k = 0 To 3
                    q = wsCW.Cells(r, 6 + 4 * g + k).Value
                    If IsNumeric(q) And q <> "" Then
                        If q > 0 Then
                            wsPH.Cells(phNext, 1).Value = wkNo
                            wsPH.Cells(phNext, 2).Value = Trim(wsCW.Cells(r, 3).Value & "")
                            wsPH.Cells(phNext, 3).Value = bom
                            wsPH.Cells(phNext, 4).Value = Array("CF", "TC", "TN", "CB")(k)
                            wsPH.Cells(phNext, 5).Value = CDate(wkStart) + g
                            wsPH.Cells(phNext, 6).Value = q
                            phNext = phNext + 1
                            cnt = cnt + 1
                        End If
                    End If
                Next k
            Next g
        End If
    Next r
    ArchiveCurrentWeek = cnt
End Function

Private Sub LoadIntoCurrentWeek(wsImp As Worksheet, wsCW As Worksheet, _
                                lastData As Long, tgtRow As Long, newStart As Date)
    Dim g As Long
    wsCW.Range("A" & GRID_FIRST & ":AD" & GRID_LAST).ClearContents
    wsCW.Range("A" & TARGET_ROW & ":AC" & TARGET_ROW).ClearContents
    wsCW.Range("E1").Value = Format(newStart, "dd/mm/yyyy") & " TO " & Format(newStart + 5, "dd/mm/yyyy")
    For g = 0 To DAYS - 1
        wsCW.Cells(3, 6 + 4 * g).Value = Day(newStart + g)
    Next g
    wsCW.Range("A" & GRID_FIRST).Resize(lastData - GRID_FIRST + 1, 30).Value = _
        wsImp.Range("A" & GRID_FIRST).Resize(lastData - GRID_FIRST + 1, 30).Value
    If tgtRow > 0 Then
        wsCW.Range("E" & TARGET_ROW).Resize(1, 25).Value = _
            wsImp.Range("E" & tgtRow).Resize(1, 25).Value
    End If
    wsCW.Cells(TARGET_ROW, 4).Value = "Daily Target / Total"
End Sub

Private Function ParseBalance(remark As String, defaultQty As Double, bal() As Variant) As Boolean
    Dim i As Long
    For i = 1 To 4: bal(i) = Empty: Next i
    If InStr(1, UCase(remark), "BALANCE", vbTextCompare) = 0 Then Exit Function
    ' normalize: uppercase, split digits from letters, non-alnum -> space
    Dim s As String, ch As String, res As String, prevD As Boolean, prevA As Boolean
    s = UCase(remark)
    For i = 1 To Len(s)
        ch = Mid(s, i, 1)
        If ch >= "0" And ch <= "9" Then
            If prevA Then res = res & " "
            res = res & ch: prevD = True: prevA = False
        ElseIf ch >= "A" And ch <= "Z" Then
            If prevD Then res = res & " "
            res = res & ch: prevA = True: prevD = False
        Else
            res = res & " ": prevD = False: prevA = False
        End If
    Next i
    Dim toks As Variant, t As Variant, cur As Variant, found As Boolean, idx As Long
    toks = Split(Application.WorksheetFunction.Trim(res), " ")
    cur = Empty
    For Each t In toks
        If IsNumeric(t) Then
            cur = CDbl(t)
        Else
            If t = "RC" Then t = "TC"   ' common typo
            idx = 0
            Select Case t
                Case "CF": idx = 1
                Case "TC": idx = 2
                Case "TN": idx = 3
                Case "CB": idx = 4
            End Select
            If idx > 0 Then
                If IsEmpty(cur) Then bal(idx) = defaultQty Else bal(idx) = cur
                found = True
            End If
        End If
    Next t
    If found Then
        For i = 1 To 4
            If IsEmpty(bal(i)) Then bal(i) = 0
        Next i
        ParseBalance = True
    End If
End Function

Private Sub UpsertOrders(wsImp As Worksheet, wsOD As Worksheet, wsHP As Worksheet, _
                         lastData As Long, newWk As Long, ByRef nNew As Long, ByRef nUpd As Long)
    Dim items(1 To 4) As String
    items(1) = "CF": items(2) = "TC": items(3) = "TN": items(4) = "CB"
    Dim dict As Object, dictHP As Object
    Set dict = CreateObject("Scripting.Dictionary")
    Set dictHP = CreateObject("Scripting.Dictionary")
    Dim r As Long
    For r = 2 To ORD_MAX
        If Trim(wsOD.Cells(r, 1).Value & "") = "" Then Exit For
        dict(Trim(wsOD.Cells(r, 1).Value) & "|" & Trim(wsOD.Cells(r, 4).Value)) = r
    Next r
    Dim odNext As Long: odNext = r
    For r = 2 To HP_MAX + 1
        If Trim(wsHP.Cells(r, 1).Value & "") = "" Then Exit For
        dictHP(Trim(wsHP.Cells(r, 1).Value)) = r
    Next r
    Dim hpNext As Long: hpNext = r

    Dim bom As String, mo As String, desc As String, qty As Double, remark As String
    Dim bal(1 To 4) As Variant, hasBal As Boolean
    Dim k As Long, key As String, tr As Long
    For r = GRID_FIRST To lastData
        mo = Trim(wsImp.Cells(r, 3).Value & "")
        If mo <> "" Then
            If Trim(wsImp.Cells(r, 1).Value & "") <> "" Then bom = Trim(wsImp.Cells(r, 1).Value & "")
            desc = Trim(wsImp.Cells(r, 4).Value & "")
            qty = Val(wsImp.Cells(r, 5).Value & "")
            remark = Trim(wsImp.Cells(r, 30).Value & "")
            hasBal = ParseBalance(remark, qty, bal)
            If Not dictHP.Exists(mo) Then
                If hpNext <= HP_MAX + 1 Then
                    wsHP.Cells(hpNext, 1).Value = mo
                    wsHP.Cells(hpNext, 2).Value = bom
                    wsHP.Cells(hpNext, 3).Value = qty
                    dictHP(mo) = hpNext
                    hpNext = hpNext + 1
                End If
            End If
            For k = 1 To 4
                key = mo & "|" & items(k)
                If dict.Exists(key) Then
                    tr = dict(key)
                    wsOD.Cells(tr, 8).Value = newWk
                    If hasBal Then
                        wsOD.Cells(tr, 9).Value = bal(k)
                    Else
                        wsOD.Cells(tr, 9).ClearContents
                    End If
                    nUpd = nUpd + 1
                Else
                    If odNext <= ORD_MAX Then
                        wsOD.Cells(odNext, 1).Value = mo
                        wsOD.Cells(odNext, 2).Value = bom
                        wsOD.Cells(odNext, 3).Value = desc
                        wsOD.Cells(odNext, 4).Value = items(k)
                        wsOD.Cells(odNext, 5).Value = qty
                        If hasBal Then
                            wsOD.Cells(odNext, 6).Value = bal(k)
                            wsOD.Cells(odNext, 9).Value = bal(k)
                        Else
                            wsOD.Cells(odNext, 6).Value = qty
                        End If
                        wsOD.Cells(odNext, 7).Value = newWk
                        wsOD.Cells(odNext, 8).Value = newWk
                        dict(key) = odNext
                        odNext = odNext + 1
                        nNew = nNew + 1
                    End If
                End If
            Next k
        End If
    Next r
End Sub

Private Function BuildReconciliation(wsOD As Worksheet, wsRC As Worksheet, newWk As Long) As Long
    wsRC.Range("A3:H10000").ClearContents
    Dim r As Long, w As Long: w = 3
    Dim pb As Variant, sysRem As Variant, delta As Variant
    For r = 2 To ORD_MAX
        If Trim(wsOD.Cells(r, 1).Value & "") = "" Then Exit For
        pb = wsOD.Cells(r, 9).Value
        sysRem = wsOD.Cells(r, 11).Value
        If IsNumeric(pb) And pb <> "" And IsNumeric(sysRem) Then
            delta = sysRem - pb
            If delta <> 0 Then
                wsRC.Cells(w, 1).Value = newWk
                wsRC.Cells(w, 2).Value = wsOD.Cells(r, 1).Value
                wsRC.Cells(w, 3).Value = wsOD.Cells(r, 2).Value
                wsRC.Cells(w, 4).Value = wsOD.Cells(r, 4).Value
                wsRC.Cells(w, 5).Value = pb
                wsRC.Cells(w, 6).Value = sysRem
                wsRC.Cells(w, 7).Value = delta
                If delta > 0 Then
                    wsRC.Cells(w, 8).Value = "System says MORE remaining than Planning - check unlogged output or planner error"
                Else
                    wsRC.Cells(w, 8).Value = "Planning says MORE remaining than system - check missing/duplicate log entries"
                End If
                w = w + 1
                BuildReconciliation = BuildReconciliation + 1
            End If
        End If
    Next r
End Function
