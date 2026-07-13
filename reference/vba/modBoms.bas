Attribute VB_Name = "modBoms"

Option Explicit
'============ modBoms - BOM normalize / excess reallocation ============

Public Sub NormalizeBoms()
    Dim orders As Worksheet, logS As Worksheet
    Set orders = Sheets("Plan Orders"): Set logS = Sheets("Daily Handover")
    Dim known As Object, prefixMap As Object
    Set known = NewDict(): Set prefixMap = NewDict()
    Dim oLast As Long: oLast = orders.Cells(orders.Rows.Count, 1).End(xlUp).Row
    Dim i As Long
    If oLast >= 2 Then
        Dim oV As Variant: oV = orders.Range("B2:B" & oLast).Value
        For i = 1 To UBound(oV, 1)
            Dim b As String: b = S(oV(i, 1))
            If b <> "" Then
                known(b) = True
                Dim p As String: p = BomPrefix(b)
                If Not prefixMap.Exists(p) Then prefixMap.Add p, NewDict()
                prefixMap(p)(b) = True
            End If
        Next i
    End If
    Dim lLast As Long: lLast = logS.Cells(logS.Rows.Count, 1).End(xlUp).Row
    If lLast < 2 Then Exit Sub
    Dim r As Long
    For r = 2 To lLast
        Dim raw As String: raw = CStr(logS.Cells(r, 3).Value & "")
        If Trim$(raw) <> "" Then
            Dim cleanS As String
            cleanS = Trim$(Replace(Replace(raw, vbCr, ""), vbLf, ""))
            Dim cell As Range: Set cell = logS.Cells(r, 3)
            If known.Exists(cleanS) Then
                If cleanS <> raw Then cell.Value = cleanS
            Else
                Dim pf As String: pf = BomPrefix(cleanS)
                Dim nCand As Long: nCand = 0
                Dim only As String: only = ""
                Dim allC As String: allC = ""
                If prefixMap.Exists(pf) Then
                    Dim kk As Variant
                    For Each kk In prefixMap(pf).Keys
                        nCand = nCand + 1: only = CStr(kk)
                        If allC <> "" Then allC = allC & ", "
                        allC = allC & CStr(kk)
                    Next kk
                End If
                cell.ClearComments
                If nCand = 1 Then
                    cell.Value = only
                    cell.Interior.Color = RGB(217, 234, 211)
                    cell.AddComment "Auto-corrected from: " & cleanS
                Else
                    cell.Interior.Color = RGB(244, 204, 204)
                    If nCand = 0 Then
                        cell.AddComment "BOM not found in any plan"
                    Else
                        cell.AddComment "Ambiguous prefix - matches: " & allC
                    End If
                End If
            End If
        End If
    Next r
End Sub

Public Function ReallocateExcess() As Long
    Dim orders As Worksheet, logS As Worksheet
    Set orders = Sheets("Plan Orders"): Set logS = Sheets("Daily Handover")
    ReallocateExcess = 0
    Dim capD As Object, fam As Object
    Set capD = NewDict(): Set fam = NewDict()
    Dim oLast As Long: oLast = orders.Cells(orders.Rows.Count, 1).End(xlUp).Row
    If oLast < 2 Then Exit Function
    Dim oV As Variant: oV = orders.Range("A2:J" & oLast).Value
    Dim i As Long
    For i = 1 To UBound(oV, 1)
        Dim wk As Double: wk = Nv(oV(i, 1))
        Dim bom As String: bom = S(oV(i, 2))
        If wk <> 0 And bom <> "" Then
            Dim itO As String: itO = S(oV(i, 6))
            DAdd capD, wk & "|" & bom & "|" & itO, Nv(oV(i, 9))
            Dim fk As String: fk = wk & "|" & BomGroup(bom)
            If Not fam.Exists(fk) Then fam.Add fk, NewDict()
            fam(fk)(bom) = True
        End If
    Next i
    Dim lLast As Long: lLast = logS.Cells(logS.Rows.Count, 1).End(xlUp).Row
    If lLast < 2 Then Exit Function
    Dim lV As Variant: lV = logS.Range("A2:F" & lLast).Value
    Dim tot As Object, rowsOf As Object
    Set tot = NewDict(): Set rowsOf = NewDict()
    Dim r As Long
    For r = 1 To UBound(lV, 1)
        Dim wk2 As Double: wk2 = Nv(lV(r, 6))
        Dim dp As String: dp = S(lV(r, 2))
        Dim bm As String: bm = S(lV(r, 3))
        Dim it2 As String: it2 = S(lV(r, 4))
        Dim q As Double: q = Nv(lV(r, 5))
        If wk2 <> 0 And bm <> "" And it2 <> "" And q > 0 Then
            Dim kx As String: kx = wk2 & "|" & dp & "|" & bm & "|" & it2
            DAdd tot, kx, q
            If Not rowsOf.Exists(kx) Then rowsOf.Add kx, New Collection
            rowsOf(kx).Add r
        End If
    Next r
    Dim appendAt As Long: appendAt = lLast + 1
    Dim moves As Long: moves = 0
    Dim depts As Variant: depts = Array("Cut", "Welding")
    Dim IT As Variant: IT = ItemsArr()
    Dim fkey As Variant
    For Each fkey In fam.Keys
        Dim boms() As String, nB As Long
        nB = fam(fkey).Count
        If nB >= 2 Then
            ReDim boms(1 To nB)
            Dim bi As Long: bi = 0
            Dim bk As Variant
            For Each bk In fam(fkey).Keys
                bi = bi + 1: boms(bi) = CStr(bk)
            Next bk
            Dim wkF As Double: wkF = CDbl(Split(CStr(fkey), "|")(0))
            Dim di As Long, ti As Long, D As Long, rcv As Long
            For di = 0 To 1
                For ti = 0 To 3
                    For D = 1 To nB
                        Dim dk As String
                        dk = wkF & "|" & depts(di) & "|" & boms(D) & "|" & IT(ti)
                        Dim excess As Double
                        excess = DGet(tot, dk) - DGet(capD, wkF & "|" & boms(D) & "|" & IT(ti))
                        If excess > 0 Then
                            For rcv = 1 To nB
                                If rcv <> D And excess > 0 Then
                                    Dim rk As String
                                    rk = wkF & "|" & depts(di) & "|" & boms(rcv) & "|" & IT(ti)
                                    Dim deficit As Double
                                    deficit = DGet(capD, wkF & "|" & boms(rcv) & "|" & IT(ti)) - DGet(tot, rk)
                                    If deficit > 0 Then
                                        Dim mv As Double: mv = excess
                                        If deficit < mv Then mv = deficit
                                        Dim remaining As Double: remaining = mv
                                        If rowsOf.Exists(dk) Then
                                            Dim lst As Collection: Set lst = rowsOf(dk)
                                            Dim j As Long
                                            For j = lst.Count To 1 Step -1
                                                If remaining <= 0 Then Exit For
                                                Dim rr As Long: rr = lst(j)
                                                Dim cur As Double
                                                cur = Nv(logS.Cells(1 + rr, 5).Value)
                                                Dim take As Double: take = cur
                                                If remaining < take Then take = remaining
                                                If take > 0 Then
                                                    logS.Cells(1 + rr, 5).Value = cur - take
                                                    logS.Cells(appendAt, 1).Value = lV(rr, 1)
                                                    logS.Cells(appendAt, 2).Value = depts(di)
                                                    With logS.Cells(appendAt, 3)
                                                        .Value = boms(rcv)
                                                        .Interior.Color = RGB(255, 242, 204)
                                                        .ClearComments
                                                        .AddComment "Auto-moved excess from " & boms(D)
                                                    End With
                                                    logS.Cells(appendAt, 4).Value = IT(ti)
                                                    logS.Cells(appendAt, 5).Value = take
                                                    logS.Cells(appendAt, 6).Value = wkF
                                                    appendAt = appendAt + 1
                                                    remaining = remaining - take
                                                    moves = moves + 1
                                                End If
                                            Next j
                                        End If
                                        Dim moved As Double: moved = mv - remaining
                                        tot(dk) = DGet(tot, dk) - moved
                                        DAdd tot, rk, moved
                                        excess = excess - moved
                                    End If
                                End If
                            Next rcv
                        End If
                    Next D
                Next ti
            Next di
        End If
    Next fkey
    ReallocateExcess = moves
End Function

Public Sub FixBoms()
    NormalizeBoms
    Dim n As Long: n = ReallocateExcess()
    MsgBox "BOM codes checked (green = auto-corrected, red = needs attention)." & vbCrLf & _
           "Excess reallocations within BOM families: " & n & " (yellow cells).", vbInformation
End Sub


