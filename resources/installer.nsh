; Instalador NSIS de ArkPm: antes de comprobar si la app está abierta se cierran todos sus procesos.
; Así no se queda pidiendo cerrarla cuando sigue en la bandeja, en segundo plano (iniciada con Windows / --hidden)
; o cuando hay una copia portable en marcha (comparte el nombre «Arkloudy.exe»).
!macro killArkPm
  nsExec::Exec 'taskkill /F /T /IM "${APP_EXECUTABLE_FILENAME}"'
  Pop $0
  Sleep 1000
!macroend

!macro customInit
  !insertmacro killArkPm
!macroend

!macro customUnInit
  !insertmacro killArkPm
!macroend
