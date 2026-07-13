Attribute VB_Name = "modWeld"
Option Explicit
'============ modWeld - "Welding Worklist" sheet ============
' Welding works leadWeld days (Lists!J3) before oven date.
' Shows the PLAN + "Cut Alarm" (did Cut finish it?).
' Today Target never exceeds what Cut already finished.
' BOMs with same base + same M number are merged (BomGroup).
' Col E "Total Required" = full remaining target from Plan Orders.

Public Sub ShowWeldingDay()
    NormalizeBoms
    ReallocateExcess
    Dim ws As Worksheet, plans As Worksheet, orders As Worksheet
    Dim logS As Worksheet, lists As Worksheet
    Set ws = Sheets("Welding Worklist"): Set plans = Sheets("Plans")
    Set orders = Sheets("Plan Orders"): Set logS = Sheets("Daily Handover")
    Set lists = Sheets("Lists")

    Dim D As Variant: D = ws.Range("B2").Value
    If Not IsDateVal(D) Then MsgBox "Pick a day in B2.", vbExclamation: Exit Sub
    Dim Dt As Long: Dt = DOnly(D)

    Dim leadWeld As Double, capItem As Double
    leadWeld = Nv(lists.Range("J3").Value): If leadWeld = 0 Then leadWeld = 1
    capItem = Nv(lists.Range("J4").Value): If capItem = 0 Then capItem = 27

    Dim planNo As Double: planNo = FindPlanForDate(Dt, leadWeld)
    If planNo = -1 Then MsgBox "No imported plan covers this date.", vbExclamation: Exit Sub

    Dim IT As Variant: IT = ItemsArr()
    Dim i As Long

    ' ---- Plans: totals + cumulative welding due ----
    Dim aKva As Object, aTot As Object, aDW As Object, kvaOf As Object
    Set aKva = NewDict(): Set aTot = NewDict(): Set aDW = NewDict(): Set kvaOf = NewDict()
    Dim pLast As Long: pLast = plans.Cells(plans.Rows.Count, 1).End(xlUp).Row
    If pLast >= 2 Then
        Dim pV As Variant: pV = plans.Range("A2:H" & pLast).Value
        For i = 1 To UBound(pV, 1)
            If Nv(pV(i, 1)) = planNo And IsDateVal(pV(i, 7)) Then
                Dim bomP As String: bomP = BomGroup(S(pV(i, 2)))
                Dim keyP As String: keyP = bomP & "|" & S(pV(i, 6))
                If Not aKva.Exists(keyP) Then aKva.Add keyP, pV(i, 5)
                DAdd aTot, keyP, Nv(pV(i, 8))
                If DOnly(pV(i, 7)) <= Dt + leadWeld Then DAdd aDW, keyP, Nv(pV(i, 8))
                kvaOf(bomP) = pV(i, 5)
            End If
        Next i
    End If

    ' ---- Plan Orders: KVA lookup + full required targets ----
    Dim kva2 As Object, tgt As Object
    Set kva2 = NewDict(): Set tgt = NewDict()
    Dim oLast As Long: oLast = orders.Cells(orders.Rows.Count, 1).End(xlUp).Row
    If oLast >= 2 Then
        Dim oV As Variant: oV = orders.Range("A2:J" & oLast).Value
        For i = 1 To UBound(oV, 1)
            If Nv(oV(i, 1)) = planNo Then
                Dim bomO2 As String: bomO2 = BomGroup(S(oV(i, 2)))
                DAdd tgt, bomO2 & "|" & S(oV(i, 6)), Nv(oV(i, 9))
                If Not kva2.Exists(bomO2) Then kva2.Add bomO2, oV(i, 5)
            End If
        Next i
    End If

    ' ---- Handover: cut ready (<= yesterday) + welding prev/today ----
    Dim cutReady As Object, weldPrev As Object, weldT As Object
    Set cutReady = NewDict(): Set weldPrev = NewDict(): Set weldT = NewDict()
    Dim lLast As Long: lLast = logS.Cells(logS.Rows.Count, 1).End(xlUp).Row
    If lLast >= 2 Then
        Dim lV As Variant: lV = logS.Range("A2:F" & lLast).Value
        For i = 1 To UBound(lV, 1)
            If Nv(lV(i, 6)) = planNo And IsDateVal(lV(i, 1)) Then
                Dim dtl As Long: dtl = DOnly(lV(i, 1))
                Dim keyL As String: keyL = BomGroup(S(lV(i, 3))) & "|" & S(lV(i, 4))
                Dim qL As Double: qL = Nv(lV(i, 5))
                If S(lV(i, 2)) = "Cut" Then
                    If dtl <= Dt - 1 Then DAdd cutReady, keyL, qL
                ElseIf S(lV(i, 2)) = "Welding" Then
                    If dtl < Dt Then DAdd weldPrev, keyL, qL
                    If dtl = Dt Then DAdd weldT, keyL, qL
                End If
            End If
        Next i
    End If

    ' ---- scheduled rows ----
    Dim out() As Variant: ReDim out(1 To aKva.Count + 200, 1 To 12)
    Dim nOut As Long: nOut = 0
    Dim schedStill As Object: Set schedStill = NewDict()
    Dim kk As Variant, parts() As String
    For Each kk In aKva.Keys
        Dim gDW As Double: gDW = DGet(aDW, CStr(kk))
        If gDW > 0 Then
            Dim dueW As Double, stillW As Double, ready As Double
            dueW = gDW - DGet(weldPrev, CStr(kk)): If dueW < 0 Then dueW = 0
            stillW = dueW - DGet(weldT, CStr(kk)): If stillW < 0 Then stillW = 0
            ready = DGet(cutReady, CStr(kk)) - DGet(weldPrev, CStr(kk)) - DGet(weldT, CStr(kk))
            If ready < 0 Then ready = 0
            schedStill(CStr(kk)) = stillW
            parts = Split(CStr(kk), "|")
            nOut = nOut + 1
            out(nOut, 1) = parts(0): out(nOut, 2) = aKva(kk): out(nOut, 3) = parts(1)
            out(nOut, 4) = "Scheduled": out(nOut, 5) = DGet(tgt, CStr(kk))
            out(nOut, 6) = dueW: out(nOut, 7) = DGet(weldT, CStr(kk)): out(nOut, 8) = stillW
            out(nOut, 9) = ready: out(nOut, 10) = 0
            If stillW = 0 Then
                out(nOut, 11) = "-"
            ElseIf ready >= stillW Then
                out(nOut, 11) = "Cut ready"
            ElseIf ready > 0 Then
                out(nOut, 11) = "Partial - " & Format(stillW - ready, "0") & " not cut"
            Else
                out(nOut, 11) = "NOT CUT YET"
            End If
            If stillW = 0 Then
                out(nOut, 12) = "Done"
            ElseIf DGet(weldT, CStr(kk)) > 0 Then
                out(nOut, 12) = "In progress"
            Else
                out(nOut, 12) = "Pending"
            End If
        End If
    Next kk

    ' sort by BOM then Item
    Dim x As Long, y As Long, c As Long, tmp As Variant
    For x = 1 To nOut - 1
        For y = x + 1 To nOut
            If out(y, 1) < out(x, 1) Or (out(y, 1) = out(x, 1) And out(y, 3) < out(x, 3)) Then
                For c = 1 To 12
                    tmp = out(x, c): out(x, c) = out(y, c): out(y, c) = tmp
                Next c
            End If
        Next y
    Next x

    ' ---- capacity allocation: Today Target = min(still due, cut ready, room) ----
    Dim capUsed As Object: Set capUsed = NewDict()
    For Each kk In weldT.Keys
        parts = Split(CStr(kk), "|")
        DAdd capUsed, parts(1), weldT(kk)
    Next kk
    For i = 1 To nOut
        Dim room As Double: room = capItem - DGet(capUsed, CStr(out(i, 3)))
        If room < 0 Then room = 0
        Dim alloc As Double: alloc = Nv(out(i, 8))
        If Nv(out(i, 9)) < alloc Then alloc = Nv(out(i, 9))
        If alloc > room Then alloc = room
        out(i, 10) = alloc
        DAdd capUsed, CStr(out(i, 3)), alloc
    Next i

    ' ---- fill-up: extra pieces Cut finished beyond the schedule ----
    For Each kk In cutReady.Keys
        Dim extra As Double
        extra = DGet(cutReady, CStr(kk)) - DGet(weldPrev, CStr(kk)) _
              - DGet(weldT, CStr(kk)) - DGet(schedStill, CStr(kk))
        If extra > 0 Then
            parts = Split(CStr(kk), "|")
            Dim roomF As Double: roomF = capItem - DGet(capUsed, parts(1))
            If roomF < 0 Then roomF = 0
            Dim takeF As Double: takeF = extra
            If roomF < takeF Then takeF = roomF
            If takeF > 0 Then
                nOut = nOut + 1
                out(nOut, 1) = parts(0)
                If kva2.Exists(parts(0)) Then
                    out(nOut, 2) = kva2(parts(0))
                ElseIf kvaOf.Exists(parts(0)) Then
                    out(nOut, 2) = kvaOf(parts(0))
                Else
                    out(nOut, 2) = ""
                End If
                out(nOut, 3) = parts(1): out(nOut, 4) = "Fill-up (cut done)"
                out(nOut, 5) = DGet(tgt, CStr(kk))
                out(nOut, 6) = takeF: out(nOut, 7) = 0: out(nOut, 8) = takeF
                out(nOut, 9) = extra: out(nOut, 10) = takeF
                out(nOut, 11) = "Cut ready": out(nOut, 12) = "Pending"
                DAdd capUsed, parts(1), takeF
            End If
        End If
    Next kk

    ws.Range("A5:L2000").ClearContents
    If nOut > 0 Then ws.Range("A5").Resize(nOut, 12).Value = out
    FormatWeldList
End Sub

Public Sub FormatWeldList()
    Dim ws As Worksheet: Set ws = Sheets("Welding Worklist")
    Application.ScreenUpdating = False
    With ws.Range("A5:L2000")
        .FormatConditions.Delete
        .Interior.ColorIndex = xlNone
        .Borders.LineStyle = xlNone
        .Font.Bold = False
        .Font.ColorIndex = xlAutomatic
        .Font.Name = "Calibri": .Font.Size = 11
        .HorizontalAlignment = xlCenter
        .VerticalAlignment = xlCenter
    End With
    Dim lastR As Long: lastR = ws.Cells(ws.Rows.Count, 1).End(xlUp).Row
    If lastR < 5 Then Application.ScreenUpdating = True: Exit Sub
    ws.Range("F5:J" & lastR).Interior.Color = RGB(221, 235, 247)
    Dim r As Long
    For r = 6 To lastR Step 2
        ws.Range("A" & r & ":E" & r).Interior.Color = RGB(242, 247, 251)
    Next r
    For r = 5 To lastR
        If ws.Cells(r, 4).Value = "Fill-up (cut done)" Then
            ws.Cells(r, 4).Interior.Color = RGB(255, 242, 204)
        End If
    Next r
    ws.Range("J5:J" & lastR).Font.Bold = True
    With ws.Range("A5:L" & lastR).Borders
        .LineStyle = xlContinuous: .Weight = xlThin: .Color = RGB(191, 191, 191)
    End With
    With ws.Range("A" & lastR & ":L" & lastR).Borders(xlEdgeBottom)
        .LineStyle = xlContinuous: .Weight = xlMedium: .Color = RGB(132, 150, 176)
    End With
    Dim al As Range: Set al = ws.Range("K5:K" & lastR)
    al.Font.Bold = True
    With al.FormatConditions.Add(Type:=xlTextString, String:="Cut ready", TextOperator:=xlContains)
        .Interior.Color = RGB(198, 239, 206): .Font.Color = RGB(0, 97, 0)
    End With
    With al.FormatConditions.Add(Type:=xlTextString, String:="Partial", TextOperator:=xlContains)
        .Interior.Color = RGB(255, 242, 204): .Font.Color = RGB(127, 96, 0)
    End With
    With al.FormatConditions.Add(Type:=xlTextString, String:="NOT CUT", TextOperator:=xlContains)
        .Interior.Color = RGB(255, 199, 206): .Font.Color = RGB(156, 0, 6)
    End With
    Dim st As Range: Set st = ws.Range("L5:L" & lastR)
    st.Font.Bold = True
    With st.FormatConditions.Add(Type:=xlTextString, String:="Done", TextOperator:=xlContains)
        .Interior.Color = RGB(198, 239, 206): .Font.Color = RGB(0, 97, 0)
    End With
    With st.FormatConditions.Add(Type:=xlTextString, String:="progress", TextOperator:=xlContains)
        .Interior.Color = RGB(255, 242, 204): .Font.Color = RGB(127, 96, 0)
    End With
    With st.FormatConditions.Add(Type:=xlTextString, String:="Pending", TextOperator:=xlContains)
        .Interior.Color = RGB(255, 199, 206): .Font.Color = RGB(156, 0, 6)
    End With
    Dim db As Databar
    Set db = ws.Range("H5:H" & lastR).FormatConditions.AddDatabar
    db.BarColor.Color = RGB(46, 117, 182)
    Application.ScreenUpdating = True
End Sub

