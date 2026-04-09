#!/usr/bin/env python3
"""
COSMO Communication System v2.0 - Demo Script

This demonstrates the complete neuroscience-grounded communication pipeline:
1. Salience Detection (Salience Network)
2. Conceptualization (DMN → Language)
3. Theory of Mind Evaluation (ToM Network)
4. Message Planning (Broca's Area)
5. Inner Speech Rehearsal (Inner Speech System)
6. Quality Monitoring (ACC + STG)
7. Channel Delivery (Motor Cortex)
8. Feedback Learning (Basal Ganglia)

Based on cosmoqueries3.md implementation.
"""

import json
import os
from datetime import datetime
from pathlib import Path

# ============================================================================
# CONFIGURATION
# ============================================================================

CONFIG = {
    "salience": {
        "novelty_weight": 0.3,
        "importance_weight": 0.4,
        "social_value_weight": 0.3,
        "threshold": 0.6,
        "dmn_boost": 1.5  # Consolidated insights get priority
    },
    "human_model": {
        "interest_threshold": 0.5,
        "verify_band": (0.4, 0.6),  # Uncertain predictions
        "learning_rate": 0.1,
        "context_window": 20
    },
    "message_planner": {
        "max_length": 500,
        "clarity_weight": 0.4,
        "conciseness_weight": 0.3,
        "engagement_weight": 0.3
    },
    "inner_speech": {
        "max_revisions": 3,
        "quality_threshold": 0.7,
        "tom_threshold": 0.6
    },
    "monitor": {
        "error_threshold": 0.3,
        "repair_strategies": ["clarify", "simplify", "elaborate"]
    },
    "channels": {
        "notification": {"max_length": 100, "urgency_min": 0.7},
        "chat": {"max_length": 500, "urgency_min": 0.4},
        "email": {"max_length": 2000, "urgency_min": 0.2},
        "dashboard": {"max_length": 1000, "urgency_min": 0.0},
        "log": {"max_length": 5000, "urgency_min": 0.0},
        "document": {"max_length": 10000, "urgency_min": 0.0},
        "api": {"max_length": 10000, "urgency_min": 0.0}
    }
}

# ============================================================================
# COMPONENT 1: SALIENCE DETECTOR (Salience Network)
# ============================================================================

class SalienceDetector:
    """Detects what's worth communicating (Salience Network)"""
    
    def __init__(self, config):
        self.config = config
        
    def detect(self, thought):
        """Calculate salience score for a thought"""
        novelty = thought.get("novelty", 0.5)
        importance = thought.get("importance", 0.5)
        social_value = thought.get("social_value", 0.5)
        is_consolidated = thought.get("is_consolidated", False)
        
        # Weighted combination
        salience = (
            novelty * self.config["novelty_weight"] +
            importance * self.config["importance_weight"] +
            social_value * self.config["social_value_weight"]
        )
        
        # DMN boost for consolidated insights
        if is_consolidated:
            salience *= self.config["dmn_boost"]
            
        return min(salience, 1.0)
    
    def should_communicate(self, thought):
        """Decide if thought crosses salience threshold"""
        salience = self.detect(thought)
        return salience >= self.config["threshold"], salience

# ============================================================================
# COMPONENT 2: CONCEPTUALIZER (Representation Gap Bridge)
# ============================================================================

class Conceptualizer:
    """Bridges graph thoughts to preverbal concepts"""
    
    def conceptualize(self, thought):
        """Transform graph representation to preverbal message"""
        # Extract key elements
        content = thought.get("content", "")
        node_type = thought.get("type", "unknown")
        relations = thought.get("relations", [])
        
        # Create preverbal concept
        concept = {
            "core_idea": content,
            "type": node_type,
            "key_relations": relations[:3],  # Top 3 most important
            "abstraction_level": self._determine_abstraction(thought),
            "communicative_intent": self._infer_intent(thought)
        }
        
        return concept
    
    def _determine_abstraction(self, thought):
        """Determine appropriate abstraction level"""
        if thought.get("is_consolidated"):
            return "high"  # Consolidated = abstract
        elif thought.get("is_specific"):
            return "low"   # Specific = concrete
        else:
            return "medium"
    
    def _infer_intent(self, thought):
        """Infer communicative intent"""
        if thought.get("is_question"):
            return "query"
        elif thought.get("is_insight"):
            return "inform"
        elif thought.get("is_suggestion"):
            return "suggest"
        else:
            return "share"

# ============================================================================
# COMPONENT 3: HUMAN MODEL (Theory of Mind)
# ============================================================================

class HumanModel:
    """Models human interests and predicts responses (ToM Network)"""
    
    def __init__(self, config):
        self.config = config
        self.interaction_history = []
        self.interest_model = {}
        
    def predict_interest(self, concept):
        """Predict if human will find this interesting"""
        # Simple heuristic model (would be ML in production)
        topic = concept.get("type", "unknown")
        abstraction = concept.get("abstraction_level", "medium")
        
        # Base interest from history
        base_interest = self.interest_model.get(topic, 0.5)
        
        # Adjust for abstraction (humans prefer medium)
        if abstraction == "medium":
            interest = base_interest * 1.2
        elif abstraction == "high":
            interest = base_interest * 0.9
        else:
            interest = base_interest
            
        return min(interest, 1.0)
    
    def should_share(self, concept):
        """Decide if we should share this with human"""
        interest = self.predict_interest(concept)
        threshold = self.config["interest_threshold"]
        verify_band = self.config["verify_band"]
        
        if interest >= threshold:
            return "accept", interest
        elif verify_band[0] <= interest < verify_band[1]:
            return "verify", interest  # Uncertain - send for verification
        else:
            return "abstain", interest  # Don't share
    
    def update_from_feedback(self, concept, feedback):
        """Learn from human feedback (reinforcement learning)"""
        topic = concept.get("type", "unknown")
        current = self.interest_model.get(topic, 0.5)
        
        # Update with learning rate
        if feedback == "positive":
            target = 1.0
        elif feedback == "negative":
            target = 0.0
        else:
            target = 0.5
            
        new_value = current + self.config["learning_rate"] * (target - current)
        self.interest_model[topic] = new_value
        
        # Store in history
        self.interaction_history.append({
            "concept": concept,
            "feedback": feedback,
            "timestamp": datetime.now().isoformat()
        })

# ============================================================================
# COMPONENT 4: MESSAGE PLANNER (Broca's Area)
# ============================================================================

class MessagePlanner:
    """Plans message structure (Broca's Area)"""
    
    def __init__(self, config):
        self.config = config
        
    def plan(self, concept):
        """Create message plan from concept"""
        intent = concept.get("communicative_intent", "share")
        
        # Template-based planning (simplified)
        if intent == "query":
            template = "I'm wondering: {core_idea}"
        elif intent == "inform":
            template = "I noticed: {core_idea}"
        elif intent == "suggest":
            template = "Consider: {core_idea}"
        else:
            template = "{core_idea}"
            
        # Fill template
        message = template.format(core_idea=concept.get("core_idea", ""))
        
        # Add relations if present
        relations = concept.get("key_relations", [])
        if relations:
            message += f" (Related to: {', '.join(relations[:2])})"
            
        return {
            "text": message,
            "intent": intent,
            "length": len(message)
        }

# ============================================================================
# COMPONENT 5: INNER SPEECH SIMULATOR (Inner Speech System)
# ============================================================================

class InnerSpeechSimulator:
    """Rehearses messages internally (Inner Speech System)"""
    
    def __init__(self, config, human_model):
        self.config = config
        self.human_model = human_model
        
    def rehearse(self, message_plan, concept):
        """Simulate message delivery and revise if needed"""
        revisions = 0
        current_message = message_plan["text"]
        
        while revisions < self.config["max_revisions"]:
            # Simulate human response
            simulated_interest = self.human_model.predict_interest(concept)
            
            # Check quality
            quality = self._assess_quality(current_message)
            
            # If good enough, stop
            if (quality >= self.config["quality_threshold"] and 
                simulated_interest >= self.config["tom_threshold"]):
                break
                
            # Otherwise, revise
            current_message = self._revise(current_message, quality, simulated_interest)
            revisions += 1
            
        return {
            "text": current_message,
            "revisions": revisions,
            "final_quality": quality,
            "predicted_interest": simulated_interest
        }
    
    def _assess_quality(self, message):
        """Assess message quality (simplified)"""
        # Simple heuristics
        length_ok = 10 <= len(message) <= 500
        has_content = len(message.strip()) > 0
        not_too_complex = message.count(",") < 5
        
        score = sum([length_ok, has_content, not_too_complex]) / 3.0
        return score
    
    def _revise(self, message, quality, interest):
        """Revise message to improve quality/interest"""
        # Simplified revision (would be more sophisticated in production)
        if quality < 0.5:
            message = message[:200]  # Simplify
        if interest < 0.5:
            message = "💡 " + message  # Add engagement
        return message

# ============================================================================
# COMPONENT 6: COMMUNICATION MONITOR (ACC + STG)
# ============================================================================

class CommunicationMonitor:
    """Monitors communication quality (ACC + STG)"""
    
    def __init__(self, config):
        self.config = config
        
    def monitor_pre_send(self, rehearsed_message):
        """Check message before sending"""
        errors = []
        
        # Check length
        if len(rehearsed_message["text"]) > 1000:
            errors.append("too_long")
            
        # Check quality
        if rehearsed_message["final_quality"] < 0.5:
            errors.append("low_quality")
            
        # Check interest
        if rehearsed_message["predicted_interest"] < 0.3:
            errors.append("low_interest")
            
        return {
            "approved": len(errors) == 0,
            "errors": errors,
            "confidence": 1.0 - len(errors) * 0.3
        }
    
    def monitor_post_send(self, message, response):
        """Monitor after sending (from human response)"""
        # Analyze response for comprehension/engagement
        if response:
            comprehension = response.get("understood", True)
            engagement = response.get("engaged", True)
            
            if not comprehension:
                return {"error": "comprehension_failure", "repair": "clarify"}
            if not engagement:
                return {"error": "low_engagement", "repair": "simplify"}
                
        return {"error": None, "repair": None}

# ============================================================================
# COMPONENT 7: CHANNEL MANAGER (Motor Cortex)
# ============================================================================

class ChannelManager:
    """Manages delivery channels (Motor Cortex)"""
    
    def __init__(self, config):
        self.config = config
        
    def select_channel(self, message, urgency=0.5):
        """Select appropriate delivery channel"""
        length = len(message["text"])
        
        # Check each channel's constraints
        for channel, constraints in self.config.items():
            if (length <= constraints["max_length"] and 
                urgency >= constraints["urgency_min"]):
                return channel
                
        return "log"  # Fallback
    
    def deliver(self, message, channel, output_dir):
        """Deliver message through selected channel"""
        timestamp = datetime.now().isoformat()
        
        # Create delivery record
        delivery = {
            "timestamp": timestamp,
            "channel": channel,
            "message": message["text"],
            "metadata": {
                "revisions": message.get("revisions", 0),
                "quality": message.get("final_quality", 0),
                "predicted_interest": message.get("predicted_interest", 0)
            }
        }
        
        # Write to stream (JSONL)
        stream_file = output_dir / "stream" / f"{timestamp.split('T')[0]}.jsonl"
        stream_file.parent.mkdir(parents=True, exist_ok=True)
        
        with open(stream_file, "a") as f:
            f.write(json.dumps(delivery) + "\n")
            
        # Also write to channel-specific output
        channel_file = output_dir / "channels" / f"{channel}.jsonl"
        channel_file.parent.mkdir(parents=True, exist_ok=True)
        
        with open(channel_file, "a") as f:
            f.write(json.dumps(delivery) + "\n")
            
        return delivery

# ============================================================================
# COMPONENT 8: FEEDBACK LOOP (Basal Ganglia)
# ============================================================================

class FeedbackLoop:
    """Learns from interactions (Basal Ganglia)"""
    
    def __init__(self, human_model):
        self.human_model = human_model
        
    def process_feedback(self, concept, delivery, response):
        """Process human feedback and update model"""
        # Determine feedback type
        if response and response.get("understood") and response.get("engaged"):
            feedback = "positive"
        elif response and not response.get("understood"):
            feedback = "negative"
        else:
            feedback = "neutral"
            
        # Update human model
        self.human_model.update_from_feedback(concept, feedback)
        
        return {
            "feedback": feedback,
            "model_updated": True
        }

# ============================================================================
# MAIN PIPELINE
# ============================================================================

class CommunicationPipeline:
    """Complete neuroscience-grounded communication pipeline"""
    
    def __init__(self, config, output_dir):
        self.config = config
        self.output_dir = Path(output_dir)
        
        # Initialize components
        self.salience_detector = SalienceDetector(config["salience"])
        self.conceptualizer = Conceptualizer()
        self.human_model = HumanModel(config["human_model"])
        self.message_planner = MessagePlanner(config["message_planner"])
        self.inner_speech = InnerSpeechSimulator(config["inner_speech"], self.human_model)
        self.monitor = CommunicationMonitor(config["monitor"])
        self.channel_manager = ChannelManager(config["channels"])
        self.feedback_loop = FeedbackLoop(self.human_model)
        
    def process(self, thought, urgency=0.5):
        """Process a thought through the complete pipeline"""
        result = {"thought": thought, "stages": {}}
        
        # Stage 1: Salience Detection
        should_communicate, salience = self.salience_detector.should_communicate(thought)
        result["stages"]["salience"] = {"score": salience, "communicate": should_communicate}
        
        if not should_communicate:
            result["decision"] = "filtered_by_salience"
            return result
            
        # Stage 2: Conceptualization
        concept = self.conceptualizer.conceptualize(thought)
        result["stages"]["conceptualization"] = concept
        
        # Stage 3: Theory of Mind Evaluation
        decision, interest = self.human_model.should_share(concept)
        result["stages"]["theory_of_mind"] = {"decision": decision, "interest": interest}
        
        if decision == "abstain":
            result["decision"] = "filtered_by_tom"
            return result
            
        # Stage 4: Message Planning
        message_plan = self.message_planner.plan(concept)
        result["stages"]["message_planning"] = message_plan
        
        # Stage 5: Inner Speech Rehearsal
        rehearsed = self.inner_speech.rehearse(message_plan, concept)
        result["stages"]["inner_speech"] = rehearsed
        
        # Stage 6: Pre-Send Monitoring
        monitor_result = self.monitor.monitor_pre_send(rehearsed)
        result["stages"]["monitoring"] = monitor_result
        
        if not monitor_result["approved"]:
            result["decision"] = "filtered_by_monitor"
            return result
            
        # Stage 7: Channel Selection & Delivery
        channel = self.channel_manager.select_channel(rehearsed, urgency)
        delivery = self.channel_manager.deliver(rehearsed, channel, self.output_dir)
        result["stages"]["delivery"] = delivery
        result["decision"] = "delivered"
        
        return result
    
    def process_feedback(self, concept, delivery, response):
        """Process feedback from human"""
        return self.feedback_loop.process_feedback(concept, delivery, response)

# ============================================================================
# DEMO
# ============================================================================

def run_demo():
    """Run demonstration of the communication system"""
    print("=" * 80)
    print("COSMO COMMUNICATION SYSTEM v2.0 - DEMO")
    print("Neuroscience-Grounded Communication Pipeline")
    print("=" * 80)
    print()
    
    # Setup
    output_dir = Path(__file__).parent.parent / "outputs" / "communication_demo"
    pipeline = CommunicationPipeline(CONFIG, output_dir)
    
    # Test thoughts
    test_thoughts = [
        {
            "content": "Discovered a pattern in user behavior: 80% of errors occur during onboarding",
            "type": "insight",
            "novelty": 0.8,
            "importance": 0.9,
            "social_value": 0.7,
            "is_consolidated": True,
            "is_insight": True,
            "relations": ["user_experience", "onboarding", "error_analysis"]
        },
        {
            "content": "Minor log entry: routine check completed",
            "type": "status",
            "novelty": 0.1,
            "importance": 0.2,
            "social_value": 0.1,
            "is_consolidated": False,
            "relations": []
        },
        {
            "content": "Should we refactor the authentication module?",
            "type": "question",
            "novelty": 0.6,
            "importance": 0.7,
            "social_value": 0.8,
            "is_consolidated": False,
            "is_question": True,
            "relations": ["authentication", "refactoring", "architecture"]
        },
        {
            "content": "Consider using caching to improve API response times",
            "type": "suggestion",
            "novelty": 0.5,
            "importance": 0.6,
            "social_value": 0.7,
            "is_consolidated": False,
            "is_suggestion": True,
            "relations": ["performance", "caching", "api"]
        }
    ]
    
    # Process each thought
    results = []
    for i, thought in enumerate(test_thoughts, 1):
        print(f"\n{'─' * 80}")
        print(f"THOUGHT {i}: {thought['content'][:60]}...")
        print(f"{'─' * 80}")
        
        result = pipeline.process(thought, urgency=0.5)
        results.append(result)
        
        # Print results
        print(f"\n✓ Salience: {result['stages']['salience']['score']:.2f} " +
              f"({'PASS' if result['stages']['salience']['communicate'] else 'FAIL'})")
        
        if "conceptualization" in result["stages"]:
            concept = result["stages"]["conceptualization"]
            print(f"✓ Concept: {concept['communicative_intent']} " +
                  f"(abstraction: {concept['abstraction_level']})")
        
        if "theory_of_mind" in result["stages"]:
            tom = result["stages"]["theory_of_mind"]
            print(f"✓ ToM: {tom['decision']} (interest: {tom['interest']:.2f})")
        
        if "inner_speech" in result["stages"]:
            inner = result["stages"]["inner_speech"]
            print(f"✓ Inner Speech: {inner['revisions']} revisions " +
                  f"(quality: {inner['final_quality']:.2f})")
        
        if "monitoring" in result["stages"]:
            monitor = result["stages"]["monitoring"]
            print(f"✓ Monitor: {'APPROVED' if monitor['approved'] else 'REJECTED'} " +
                  f"(confidence: {monitor['confidence']:.2f})")
        
        if "delivery" in result["stages"]:
            delivery = result["stages"]["delivery"]
            print(f"✓ Delivered via: {delivery['channel']}")
            print(f"  Message: {delivery['message'][:100]}...")
        
        print(f"\n→ DECISION: {result['decision']}")
    
    # Summary
    print(f"\n{'=' * 80}")
    print("SUMMARY")
    print(f"{'=' * 80}")
    print(f"Total thoughts: {len(test_thoughts)}")
    print(f"Delivered: {sum(1 for r in results if r['decision'] == 'delivered')}")
    print(f"Filtered by salience: {sum(1 for r in results if r['decision'] == 'filtered_by_salience')}")
    print(f"Filtered by ToM: {sum(1 for r in results if r['decision'] == 'filtered_by_tom')}")
    print(f"Filtered by monitor: {sum(1 for r in results if r['decision'] == 'filtered_by_monitor')}")
    print(f"\nOutputs written to: {output_dir}")
    print(f"  - Stream: {output_dir / 'stream'}")
    print(f"  - Channels: {output_dir / 'channels'}")
    
    # Save full results
    results_file = output_dir / "demo_results.json"
    results_file.parent.mkdir(parents=True, exist_ok=True)
    with open(results_file, "w") as f:
        json.dump(results, f, indent=2)
    print(f"  - Full results: {results_file}")
    
    print(f"\n{'=' * 80}")
    print("✓ DEMO COMPLETE")
    print(f"{'=' * 80}\n")

if __name__ == "__main__":
    run_demo()
