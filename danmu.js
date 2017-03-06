const request   = require('superagent');
const net       = require('net');   // net 模块中含有TCP套接字编程
const fs        = require('fs');
const exec      = require('child_process').exec;

const config    = require('./config.js');
const common    = require("./common.js");

class Danmu{
    constructor(){

        // 全局 client
        this.client = new net.Socket();

        // 用于发送心跳包的计时器
        this.heartTimer = null;

        // 当前弹幕收集器的标识符, 区分不同弹幕收集器的重要标志, 在每次弹幕收集器开启时更新
        this.currentSymbol = null;

        // 当前所收集的房间号
        this.currentRoomID = null;

        // 当前弹幕收集器开始运行的时间, 以 s 计, 该变量用于控制弹幕的相对时间, 在每次弹幕收集器开启时更新
        this.xmlTime = null;

        // 当前弹幕所使用的弹幕服务器
        this.danmuServer = null

        // 当前弹幕文件的文件名
        this.curFileName = {
            danmuFileName : null,
            danmuAssFileName: null,
            danmuTempFileName: null
        }

        // 之前弹幕文件的文件名
        this.preFileName = {
            currentSymbol : null,
            danmuFileName : null,
            danmuAssFileName : null,
            danmuTempFileName : null
        }

        /**
         * 为客户端添加“data”事件处理函数
         * data是服务器发回的数据
         *
         * 在此直播监听程序中, 服务器返回的数据只可能是弹幕信息
         * 因此本函数是对弹幕数据进行解析和记录
         */
        this.client.on('data', (data) => {

            // 原始字符串
            let rawStr = data.toString()
            let pattern = /{"info":.*?"cmd":"(.*?)"}/g;

            // 通过循环将一组数据的每一条弹幕都进行输出
            while (true) {

                let match = pattern.exec(rawStr)
                if (match === null) break;

                // match[0] 是匹配到的单个弹幕的json字符串
                let msgObj = JSON.parse(match[0]);

                // 弹幕消息
                if (msgObj.cmd === "DANMU_MSG") {
                    common.logDanmu(msgObj.info[2][1] + " 说: " + msgObj.info[1])

                    // 对弹幕文件进行转义：&，<，>
                    msgObj.info[1] = msgObj.info[1].replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

                    let oneDanmu = '<d p="' + (msgObj.info[0][4] - this.xmlTime) + ',' +
                        msgObj.info[0][1] + ',' + msgObj.info[0][2] + ',' +
                        msgObj.info[0][3] + ',' + msgObj.info[0][4] + ',' +
                        'xxxxxxxx' + ',' + '1000000000' + '">' + msgObj.info[1] + '</d>\n';

                    // 向临时文件里追加数据
                    fs.appendFile(this.curFileName.danmuTempFileName, oneDanmu, function (err) {
                        if (err) return common.logError(err.toString())
                    });
                }
            }
        });

        // 为客户端添加“close”事件处理函数
        this.client.on('close', () => {
            common.log('Connection closed ID: ' + this.preFileName.currentSymbol);

            // 套接字关闭后, 将心跳包传输关闭
            clearInterval(this.heartTimer);

            // 处理临时xml文件, 使其成为标准xml文件
            fs.readFile(this.preFileName.danmuTempFileName, 'utf8', (err, data) => {

                if (err) {
                    common.logError('奇怪呢..这里不应该出错诶...  错误 : 打开 xml_temp 文件失败!');
                    common.logError(err.toString());
                    return;
                }

                let newDanmuContent = '<?xml version="1.0" encoding="UTF-8"?><i><chatserver>chat.bilibili.com</chatserver><chatid>8888888</chatid><mission>0</mission><maxlimit>8888</maxlimit><source>k-v</source>' + data + '</i>';

                // 生成标准xml文件
                fs.writeFile(this.preFileName.danmuFileName, newDanmuContent, (err) => {
                    if (err) throw err;
                    common.log("新弹幕文件已生成!");

                    // 调用 danmaku2ass 生成标准ass文件
                    let pythonCommand = `${config.pythonName} ./danmaku2ass.py -o ${this.preFileName.danmuAssFileName} -s ${config.s} -fn ${config.fn} -fs ${config.fs} -a ${config.a} -dm ${config.dm} -ds ${config.ds} ${this.preFileName.danmuFileName}`;
                    console.log(pythonCommand)
                    //python3 ./danmaku2ass.py -o ./download/20161028_214338.ass -s 1920x1080 -fn 'Noto Sans CJK SC Regular' -fs 48 -a 0.8 -dm 8 -ds 5 ./download/20161028_214338.xml

                    // 执行生成 ass 文件的命令
                    exec(pythonCommand, (err, stdout, stderr) => {
                        if (err) {
                            return common.logError("ass文件生成 err 输出: " + err.toString());
                        }

                        common.log('视频ass文件成功生成!')

                        if (stdout) common.log(`ass文件生成 stdout 输出: ${stdout}`)
                        if (stderr) common.logError(`ass文件生成 stderr 输出: ${stderr}`)

                    })

                    // 删除临时xml文件
                    fs.unlink(this.preFileName.danmuTempFileName, (err) => {
                        if (err) return common.logError("临时 xml 文件删除中发生错误 : " + err.toString());

                        common.log("旧弹幕文件已删除!")
                    })
                })
            })
        });

        // 为客户端添加 "error" 事件处理函数
        this.client.on("error", (err) => {
            common.logError("弹幕收集器发生错误 : " + err.toString());
        })
    }

    /**
     * 开始启动弹幕服务器
     * @param  {string} RoomId            直播间的真实房间号
     * @param  {string} currentSymbolTemp 由调用方提供的本次抓取的标识符
     */
    async startDanmuServer(RoomId, currentSymbolTemp){

        try{
            // 加上判断语句是可能会出现 startDanmuServer 错误(虽然在B站更新弹幕服务器后这种错误不会出现了... 不过以防万一还是加上比较好), 如果是错误重试的话就不用再更新以下的内容了
            if (this.currentSymbol !== currentSymbolTemp) {

                // 每次开启弹幕收集器时, 将 app.js 文件中生成的 currentSymbol 更新到当前文件
                this.currentSymbol = currentSymbolTemp;

                this.currentRoomID = RoomId;

                // 每次开启弹幕收集器时, 更新 xmlTime
                // 因为每次视频都会向前多加载一段时间, 所以此处拟合为 -5 秒
                this.xmlTime = Math.ceil(+new Date() / 1000) - 5;

                // 每次开启弹幕收集器时, 更新文件名变量
                this.curFileName.danmuFileName     = "./download/" + this.currentSymbol + '.xml';
                this.curFileName.danmuAssFileName  = "./download/" + this.currentSymbol + '.ass';
                this.curFileName.danmuTempFileName = "./download/" + this.currentSymbol + '_temp.xml';

            }

            // 12月11日 更新 弹幕服务器再一次更新
            let res = await request.get("http://live.bilibili.com/api/player?id=cid:" + RoomId).timeout(3000)
            this.danmuServer = res.text.match(/livecmt.*?com/)[0];
            common.log("成功解析弹幕服务器地址: " + this.danmuServer);

            // 在求出弹幕服务器之后, 就要进行获取弹幕的连接了
            this.startTCPClient();

        } catch(err) {
            if (err.timeout) {
                let _this = this;
                await common.timeoutWithAsync(async function () {
                    common.logError("startDanmuServer 错误, 将在一定时间后重试")
                    common.logError(err.toString())
                    await _this.startDanmuServer()
                }, config.timeout)
            } else throw err;
        }
    }

    // 开启 TCP 链接, 以从服务器接收弹幕数据
    startTCPClient(){

        let HOST = this.danmuServer;
        let PORT = 788;

        // 正式开启TCP连接
        this.client.connect(PORT, HOST, () => {

            common.log('CONNECTED TO: ' + HOST + ':' + PORT + ' ID: ' + this.currentSymbol);

            // 在连接刚建立时新建弹幕临时文件, 以防止在整个阶段没有弹幕而导致文件无法生成进而引发Bug
            fs.appendFile(this.curFileName.danmuTempFileName, '', (err) => {
                if (err) return common.logError(err.toString());
            });

            // 每隔30秒发送一次心跳包
            // 心跳包格式固定, 不要修改
            this.heartTimer = setInterval(() => {
                let heart = new Buffer([0x00, 0x00, 0x00, 0x10, 0x00, 0x10, 0x00, 0x01, 0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00, 0x01]);
                this.client.write(Buffer(heart));
                common.logSimple("已发送心跳包!")
            }, 30000)

            // 开启直播间所需要发送的数据包 其头部格式第4项是数据包的长度
            let head = new Buffer([0x00, 0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x01, 0x00, 0x00, 0x00, 0x07, 0x00, 0x00, 0x00, 0x01]);
            let body = JSON.stringify({ roomid: Number(this.currentRoomID), uid: Math.ceil(100000000000000.0 + 200000000000000.0 * Math.random()) })
            let buffer = Buffer(head + body);
            buffer[3] = buffer.length;

            // 第一次发送数据包
            this.client.write(Buffer(buffer));
            common.log("已发送开启弹幕收集器所需要的数据包");
        });
    }

    // 关闭弹幕收集器
    stopDanmuServer() {

        // 将重启之前的标识存入变量
        this.preFileName.currentSymbol = this.currentSymbol;
        this.preFileName.danmuFileName = this.curFileName.danmuFileName;
        this.preFileName.danmuAssFileName = this.curFileName.danmuAssFileName;
        this.preFileName.danmuTempFileName = this.curFileName.danmuTempFileName;

        this.client.destroy();
    }

    // 重启弹幕收集器
    restartDanmuServer(RoomId, currentSymbolTemp) {
        this.stopDanmuServer();
        this.startDanmuServer(RoomId, currentSymbolTemp)
    }
}

module.exports = Danmu;