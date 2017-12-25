const request = require('superagent');
const fs      = require('fs');
const fsp     = require('fs-promise');
const colors  = require('colors'); 

/*关于该程序的一些设置*/
const config  = require('./config.js');

/* 常用函数 */
const common  = require("./common.js")

/*消息通知插件*/
const showMsg = require("./message/index.js");

/* 弹幕功能 */
const Danmu   = require("./danmu.js");

// 检查 python 指令
common.checkPython(config.pythonName, (err) => {
    if (err) return common.logError(err.toString());
})

class BLive{
    constructor(RoomId, danmu){

        // 所接受的视频的房间号
        this.RoomId = RoomId;

        // 所接受的弹幕服务器对象
        this.danmu = danmu;

        // 直播间是否开启
        this.statusFlag = false;

        // 文件传输是否正在进行
        this.streamFlag = false;

        // 传输数据的临时值
        this.tempBytesRead = -1;

        // 当前弹幕收集器所收集的弹幕是否为在有视频流的情况下收集的弹幕
        this.danmuFlag = false;

        // 判断当前接受弹幕是否为第一次
        this.firstFlag = true;

        // 用于接收视频流的 RBQ
        this.videoRBQ = null;

        // 当前视频和弹幕的 Symbol, Symbol 用于区分不同时期的弹幕和视频
        this.currentSymbol = null;

        // 房间基本信息
        this.roomInformation = {
            
            // 真实房间RoomID
            TrueRoomID : undefined,

            // 房间标题
            RoomTitle  : undefined,

            // 房间 UP 主名称
            RoomUP     : undefined
        }
    }

    /**
     * 开始爬取视频数据!
     */
    start(){
        this.getTrueRoomID(this.RoomId)
            .then(this.makeNewDirection)
            .then(() => { this.checkRoomInfo()});

        // 定时检查视频连接是否还在, 如果已断开则重连
        setInterval(() => {
            this.checkRoomInfo();
            this.checkStreamBytes();
        }, 20000)
    }

    /**
     * 根据 URL 上显示的房间号, 获取到真实有效的直播房间号
     * 此函数不返回数据, 而是将房间的真实房间号保存到对象上
     * 
     * @param {string} RoomId URL上显示的房间号(以字符串形式)
     */
    async getTrueRoomID(RoomId){
        try{

            // 获取直播间真实直播地址
            let resRoomId = await request.get(`http://api.live.bilibili.com/room/v1/Room/room_init?id=${RoomId}`).timeout(3000);
            // 一定几率不给回传数据
            if (!resRoomId) { throw new Error("未接收到房间真实ID的回传数据"); }
            let TrueRoomID = resRoomId.body.data.room_id;

            // 获取直播间信息
            let resTitle = await request.get(`http://api.live.bilibili.com/room/v1/Room/get_info?room_id=${TrueRoomID}&from=room`).timeout(3000);
            let resUP = await request.get(`http://api.live.bilibili.com/live_user/v1/UserInfo/get_anchor_in_room?roomid=${TrueRoomID}`).timeout(3000);
            if (!resTitle || !resUP) { throw new Error("未接收到房间信息的回传数据"); }
            let RoomTitle = resTitle.body.data.title;
            let RoomUP = resUP.body.data.info.uname;

            this.roomInformation = { TrueRoomID, RoomTitle, RoomUP};

            common.log(`房间信息 : 输入的房间地址为 ${RoomId}, 已解析出房间真实地址为 ${TrueRoomID}`);
            common.log(`房间信息 : 房间标题为 ${RoomTitle}, UP主为 ${RoomUP}`)

            return TrueRoomID;

        } catch (err) {
            let _this = this;
            await common.timeoutWithAsync(async function() {
                common.logError("getTrueRoomID 错误, 将在一定时间后重试")
                common.logError(err.toString())
                await _this.getTrueRoomID(RoomId)
            }, config.timeout)
        }
    }

    /**
     * 在当前目录下新建一个名为 download 的文件夹
     * 可能文件夹已存在, 所以忽略错误
     */
    makeNewDirection(){
        return fsp.mkdir("./download/").catch(()=>{})
    }

    /**
     * 视频服务器的检查连接
     * 并根据检查情况的不同执行不同的操作
     */
    async checkRoomInfo(){
        try{
            common.logSimple(this.currentSymbol + " -- 当前状态 : statusFlag " + this.statusFlag + "  streamFlag " + this.streamFlag)

            let fetchURL = 'http://api.live.bilibili.com/room/v1/Room/get_info?room_id=' + this.roomInformation.TrueRoomID;
            let infoRes = await request.get(fetchURL).timeout(5000);

            /**
             * infoRes.body.data.live_status 的值会有如下取值:  0 --- 未直播  1 --- 正在直播  2 --- 正在轮播
             * 但需要注意的是, 直播间开启并不代表up主正在上传视频, 因为两者并不同步
             */
            switch (infoRes.body.data.live_status) {

                // 如果直播间开启, 而且之前直播间是关闭的, 则调用 startDownload 开始下载视频
                case 1:

                    if (!this.statusFlag || !this.streamFlag) {
                        common.log(`直播间 ${this.RoomId} 已经开启`);
                        showMsg("BLive 直播监听程序", `直播间 ${this.RoomId} 已经开启`, (err) => { });

                        // 每次直播打开时, 都应该重置标识符, 同时重启弹幕收集器
                        // 为了防止因错误引发的延时, 标识符重置和弹幕开启下载均放在了 startDownload 函数中
                        this.startDownload();
                    }
                    this.statusFlag = true;
                    this.danmuFlag  = true;
                    break;

                // 如果直播间关闭, 而且之前直播间是开启的, 则断开连接
                case 0:
                    if (this.statusFlag) {
                        common.log(`直播间 ${this.RoomId} 已经关闭`);
                        showMsg("BLive 直播监听程序", `直播间 ${this.RoomId} 已经关闭`, (err) => { });
                        this.statusFlag = false;
                        if (this.streamFlag) {
                            this.videoRBQ.abort();
                            this.check0ByteVideo(this.currentSymbol);
                            this.streamFlag = false;
                        }
                    }

                    // 弹幕重启下载
                    if (this.danmuFlag || this.firstFlag) {
                        common.log("直播间已关闭, 故弹幕收集器已重启!")

                        this.currentSymbol = common.createSymbol(this.roomInformation.RoomUP, true);
                        this.danmu.restartDanmuServer(this.roomInformation.TrueRoomID, this.currentSymbol)
                        this.danmuFlag = 0;
                    }

                    this.firstFlag = 0;
                    break;
                
                // 大发慈悲地对轮播进行一下处理
                case 2:
                    common.logError("直播间正在进行轮播, 本程序表示懒得处理轮播相关的内容, 自己去下载视频去");
                    process.exit(1);


                // 理论上是不会走到这一块的..
                // 如果走到的话...一般是此次请求未收到数据或收到了错误的数据
                default:
                    common.logError('直播间状态未知');
                    common.logError(`收到的状态码为 : ${infoRes.body.data.live_status}`);

            }
        } catch (err) {
            let _this = this;
            await common.timeoutWithAsync(async function () {
                common.logError("checkRoomInfo 错误, 将在一定时间后重试")
                common.logError(err.toString())
                await _this.checkRoomInfo()
            }, config.timeout)
        }
    }

    /**
     * 检查当前视频流是否断线
     */
    checkStreamBytes(){
        // 如果视频流没有传输数据, 就不检查
        if (this.streamFlag === false) return;

        if (this.videoRBQ && this.videoRBQ.req.socket.bytesRead === this.tempBytesRead) {

            this.videoRBQ.abort();
            this.check0ByteVideo(this.currentSymbol);
            this.streamFlag = false;
            this.tempBytesRead = -1;

            common.log("因长时间未接收到数据, 连接已主动断开");
            showMsg("BLive 直播监听程序", `因长时间未接收到数据, 直播间 ${this.RoomId} 的连接已断开`, (err) => { });

            // 网络原因断开后, 弹幕收集器重启
            common.log("连接长时间未接收到数据, 故弹幕收集器已重启!")

            this.currentSymbol = common.createSymbol(this.roomInformation.RoomUP, true);
            this.danmu.restartDanmuServer(this.roomInformation.TrueRoomID, this.currentSymbol)

            // this.danmuFlag = 0;

            // 如果判断语句中的两者不相等, 则代表数据依然在传输, 则更新目前已传输数据
        } else if (this.streamFlag) {
            common.logSimple("当前阶段传输数据量 : " + (this.videoRBQ.req.socket.bytesRead - this.tempBytesRead) / 1000 + "KB/20s")
            this.tempBytesRead = this.videoRBQ.req.socket.bytesRead;
        }
    }

    /**
     * 开始对指定房间里的直播视频流进行下载
     */
    async startDownload(){
        try{
            // 重置标识符
            this.currentSymbol = common.createSymbol(this.roomInformation.RoomUP);

            // 要保存的视频的名称, 格式为 20160625_223516.flv
            let fileName = this.currentSymbol + '.flv';

            // 定义流, 用于保存视频文件
            let stream = fs.createWriteStream("./download/" + fileName);

            // 用于请求下载地址的地址
            let getLinkURL = `https://api.live.bilibili.com/api/playurl?cid=${this.roomInformation.TrueRoomID}&otype=json&quality=0&platform=web`;

            // 发送请求, 该请求用于获取视频的下载地址
            let urlRes = await request.get(getLinkURL).timeout(5000)

            // 若运行到此处, 则代表已接收到了视频地址, 接下来进行解析
            let url = JSON.parse(urlRes.text).durl[0].url;

            common.log('已解析出下载地址, 开始下载, 保存的视频的文件名为 : ' + fileName)

            this.streamFlag = true;

            // 弹幕开启下载
            common.log("视频即将开始下载, 故弹幕收集器已重启!")
            this.danmu.restartDanmuServer(this.roomInformation.TrueRoomID, this.currentSymbol)

            // 此处开始真正地下载视频, 并接到之前定义的文件上
            this.videoRBQ = request.get(url);
            this.videoRBQ.pipe(stream)

            this.videoRBQ.on("error", (err) => {
                common.log("videoRBQ 发生错误 : " + err);
                process.exit(-1);
            })
        } catch(err) {
            let _this = this;
            await common.timeoutWithAsync(async function () {
                common.logError("startDownload 错误, 将在一定时间后重试")
                common.logError(err.toString())
                await _this.startDownload()
            }, config.timeout)
        }
    }

    /**
     * 检查刚产生的视频文件是否为0KB, 如果是, 则等待字幕生成成功后删去视频文件和字幕文件
     */
    check0ByteVideo(checkSymbol){
        setTimeout(() => {
            fsp.stat("./download/" + checkSymbol + ".flv").then((stats) => {

                if (stats.size < 1000) {
                    common.log(`发现 0 字节视频, 标识符为 ${checkSymbol}, 即将进行删除工作!`)

                    fsp.unlink("./download/" + checkSymbol + ".flv").catch(() => { });
                    fsp.unlink("./download/" + checkSymbol + ".ass").catch(() => { });
                    fsp.unlink("./download/" + checkSymbol + ".xml").catch(() => { });
                }
            }).catch(err => { common.logError("检查0字节文件发送错误 : " + err.toString());})
        }, 3000)
    }

    /**
     * 停止弹幕服务器的运行
     */
    stopDanmu(){
        this.danmu.stopDanmuServer();
    }
}

// 使nodejs在关闭程序前先对已保存的弹幕临时文件进行处理
process.stdin.resume();
process.on('SIGINT', function () {
    common.log("已收到退出信号!程序将在3秒后停止运行");
    
    // 停止所有弹幕服务器
    bliveArr.forEach(item => item.stopDanmu());

    setTimeout(() => {process.exit(0);}, 3000)
});


let bliveArr = [];

// Start!
if (process.argv.length === 2){
    let danmu = new Danmu();
    let blive = new BLive(config.roomId, danmu);
    blive.start();

    bliveArr.push(blive)

} else {
    process.argv.forEach((item, index) => {
        if (index > 1) {
            let danmu = new Danmu();
            let blive = new BLive(item, danmu);
            blive.start();

            bliveArr.push(blive)
        }
    })
}

