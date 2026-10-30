const UserSession = require("../models/UserSession");
const BotFlow = require("../models/BotFlow"); // Database model for saved flows
const { sendWhatsAppMessage, sendInteractiveButtons } = require("../services/whatsappService");

exports.handleIncomingMessage = async (req, res) => {
  try {
    const { from, messageText } = req.body;
    if (!from || !messageText) return res.sendStatus(400);

    const cleanText = messageText.trim().toLowerCase();

    // 1. Fetch or Initialize User Session State
    let session = await UserSession.findOne({ phone: from });
    if (!session) {
      session = await UserSession.create({ phone: from, currentStep: "START" });
    }

    console.log(`Customer: ${from} | Current Level: ${session.currentStep} | Input: ${cleanText}`);

    // 2. Fetch Active Flow from MongoDB (created by React Flow Builder)
    const activeFlow = await BotFlow.findOne({ isActive: true });
    if (!activeFlow || !activeFlow.nodes || activeFlow.nodes.length === 0) {
      console.log("⚠️ No active flow found in Database.");
      return res.sendStatus(200);
    }

    // Direct Reset Keyword Check
    if (cleanText === "menu" || cleanText === "reset") {
      session.currentStep = "START";
    }

    // 3. Find Matching Trigger/Start Node matching Current Level
    let currentNode = activeFlow.nodes.find((node) => {
      const nodeLevel = (node.data?.level || "START").toUpperCase();
      const userLevel = session.currentStep.toUpperCase();

      if (nodeLevel !== userLevel) return false;

      // Match Trigger Nodes with keywords
      if (node.type === "triggerNode") {
        const keywords = (node.data?.keyword || "")
          .toLowerCase()
          .split(",")
          .map((k) => k.trim());
        return keywords.some((kw) => cleanText.includes(kw) || cleanText === kw);
      }

      // Match logic for interactive choices / text matches
      return true;
    });

    // Fallback: If no node matched at current level, check if user triggered 'START' keyword
    if (!currentNode && session.currentStep !== "START") {
      currentNode = activeFlow.nodes.find((node) => {
        const nodeLevel = (node.data?.level || "START").toUpperCase();
        if (nodeLevel !== "START" || node.type !== "triggerNode") return false;

        const keywords = (node.data?.keyword || "").toLowerCase().split(",").map((k) => k.trim());
        return keywords.some((kw) => cleanText.includes(kw));
      });

      if (currentNode) session.currentStep = "START";
    }

    if (!currentNode) {
      console.log("No node matched for input.");
      return res.sendStatus(200);
    }

    // 4. 🔥 TRAVERSE & EXECUTE CONNECTED NODES CHAIN
    let executingNode = currentNode;
    let nextStepLevel = session.currentStep;

    while (executingNode) {
      nextStepLevel = executingNode.data?.nextLevel || nextStepLevel;

      // (A) Process Text Message Node
      if (executingNode.type === "messageNode") {
        if (executingNode.data?.message) {
          await sendWhatsAppMessage(from, executingNode.data.message);
        }
      }

      // (B) Process Interactive Buttons Node
      else if (executingNode.type === "buttonsNode") {
        const buttonList = (executingNode.data?.buttons || []).map((btn, idx) => ({
          id: `btn_${idx + 1}`,
          title: typeof btn === "string" ? btn : btn.text || `Option ${idx + 1}`,
        }));

        await sendInteractiveButtons(from, {
          title: executingNode.data?.title || "Please select an option:",
          buttons: buttonList,
        });
      }

      // Find if there is an edge connecting to the next node automatically
      const nextEdge = activeFlow.edges.find((edge) => edge.source === executingNode.id);

      if (nextEdge) {
        // Move to connected node inside graph
        executingNode = activeFlow.nodes.find((n) => n.id === nextEdge.target);
      } else {
        // End of immediate sequence
        executingNode = null;
      }
    }

    // 5. Update User Session Level for Next Turn
    session.currentStep = nextStepLevel;
    await session.save();

    return res.sendStatus(200);
  } catch (error) {
    console.error("WhatsApp Flow Processing Error:", error);
    res.status(500).send("Error executing flow");
  }
};