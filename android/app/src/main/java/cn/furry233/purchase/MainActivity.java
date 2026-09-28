/**
 * Android 原生壳入口 Activity
 *
 * 职责：继承 Capacitor 的 BridgeActivity，把 WebView 指向 capacitor.config.json 里的 server.url，
 * 即整套界面仍是网页（public/），原生层只提供壳与插件能力。
 */
package cn.furry233.purchase;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

import cn.furry233.purchase.plugins.apkinstaller.ApkInstallerPlugin;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // 注册应用内更新安装插件（下载 → 校验 → 系统安装界面 → 结果回调）
        registerPlugin(ApkInstallerPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
