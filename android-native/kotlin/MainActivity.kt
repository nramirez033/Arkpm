package com.ark.arkpm

import android.graphics.Color
import android.os.Bundle
import android.view.View
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import com.getcapacitor.BridgeActivity

class MainActivity : BridgeActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        registerPlugin(ArkpmSshPlugin::class.java)
        super.onCreate(savedInstanceState)
        applyInsets()
    }

    /**
     * Android 15+ dibuja la app bajo las barras del sistema. Se reserva ese espacio como relleno del contenedor del
     * WebView (notch, gestos y teclado incluidos) para que nada quede tapado, en móvil y en tableta.
     */
    private fun applyInsets() {
        val bg = Color.parseColor("#161717")
        WindowCompat.setDecorFitsSystemWindows(window, false)
        val root = findViewById<View>(android.R.id.content)
        root.setBackgroundColor(bg)
        window.statusBarColor = Color.TRANSPARENT
        window.navigationBarColor = Color.TRANSPARENT
        WindowInsetsControllerCompat(window, root).apply {
            isAppearanceLightStatusBars = false
            isAppearanceLightNavigationBars = false
        }
        ViewCompat.setOnApplyWindowInsetsListener(root) { v, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
            v.setPadding(bars.left, bars.top, bars.right, maxOf(bars.bottom, ime.bottom))
            WindowInsetsCompat.CONSUMED
        }
        ViewCompat.requestApplyInsets(root)
    }
}
