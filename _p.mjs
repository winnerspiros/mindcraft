const {isYandere,personality}=await import("/home/ubuntu/uwu-bot/src/utils/server_context.js");
console.log("personality:",personality());
console.log("isYandere:",isYandere());
const {scrubEmoji}=await import("/home/ubuntu/uwu-bot/src/utils/emoji_scrub.js");
console.log("scrub live:",JSON.stringify(scrubEmoji("hey :) i like you <3 xD")));