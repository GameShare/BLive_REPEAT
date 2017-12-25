# Bilibili 直播抓取程序 REPEAT v2.0.1

##  这是什么

这是一个可以抓取B站直播视频和弹幕的脚本 ≖‿≖✧

该脚本在可以实现监听直播的状况并在直播开启时下载直播视频, 并实时记录直播弹幕, 同时提供将记录到的弹幕转化为ass文件的功能.

##  这玩意儿该怎么用?

直接用www

进行好设置后(在config.js里进行相关设置), 在当前目录下用终端运行 `node app.js` 即可 ╮（￣▽￣）╭

房间号也可以直接在终端输入 `node app.js 房间号` 设置

若需要监听多个房间, 请使用 `node app.js 房间号1 房间号2 房间号3` 的指令

若要结束监听, 为使程序正常生成 ass 文件, 请使用 `Ctrl+C` 的指令结束程序

##  这玩意需要安装什么其他东西吗?

肯定需要啦!!

请确保计算机上已经安装了 node(版本 v7.6.0 及以上), python3

在首次运行之前, 请在目录下用终端运行 npm install 以安装依赖


##  本程序使用了 danmaku2ass (https://github.com/m13253/danmaku2ass)


##  其他

见程序注释 (・ˍ・*)

##  历史版本

v2.0.1
B站直播部分接口发生了变化, 进行调整

v2.0.0
修改程序结构

v1.0.0
初版
